package angel

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// BookReq is the request body for order/trade book reads.
type BookReq struct {
	Client ClientCreds `json:"client"`
}

// PlaceBasketReq is the request body for placing selected basket legs.
type PlaceBasketReq struct {
	Client ClientCreds `json:"client"`
	Legs   []Leg       `json:"legs"`
}

// GetOrderBook returns the current Angel order book for the selected account.
func (c *Client) GetOrderBook(ctx context.Context, req BookReq) (map[string]any, error) {
	return c.book(ctx, req.Client, "/rest/secure/angelbroking/order/v1/getOrderBook", "orders")
}

// GetTradeBook returns the current Angel trade book for the selected account.
func (c *Client) GetTradeBook(ctx context.Context, req BookReq) (map[string]any, error) {
	return c.book(ctx, req.Client, "/rest/secure/angelbroking/order/v1/getTradeBook", "trades")
}

// PlaceBasket places each selected basket leg as a regular SmartAPI order. The
// frontend gates this behind a preview + confirm step; this method only submits
// the explicit payload it receives.
func (c *Client) PlaceBasket(ctx context.Context, req PlaceBasketReq) (map[string]any, error) {
	orders := make([]map[string]any, 0, len(req.Legs))
	for _, leg := range req.Legs {
		order, err := placeOrderPayload(leg)
		if err != nil {
			orders = append(orders, map[string]any{
				"status": false,
				"error":  err.Error(),
				"leg":    placeLegLabel(leg),
			})
			continue
		}
		orders = append(orders, order)
		if len(orders) >= 50 {
			break
		}
	}
	if len(orders) == 0 {
		return map[string]any{"status": true, "empty": true, "results": []any{}}, nil
	}

	session, err := c.sessionOrLogin(ctx, req.Client)
	if err != nil {
		return nil, fmt.Errorf("Angel session unavailable for placing orders")
	}
	headers := c.smartHeaders(req.Client.APIKey)

	results := make([]map[string]any, 0, len(orders))
	relogged := false
	for _, order := range orders {
		if ok, _ := order["status"].(bool); !ok && order["error"] != nil {
			results = append(results, order)
			continue
		}

		result, err := c.doJSON(ctx, "POST", "/rest/secure/angelbroking/order/v1/placeOrder", authHeaders(headers, session.JWTToken), order)
		if err != nil && !relogged {
			relogin, rerr := c.AutoLogin(ctx, withoutSession(req.Client))
			if rerr == nil {
				if next := sessionFromResponse(relogin); next != nil {
					session = next
					relogged = true
					result, err = c.doJSON(ctx, "POST", "/rest/secure/angelbroking/order/v1/placeOrder", authHeaders(headers, session.JWTToken), order)
				}
			}
		}
		results = append(results, placeOrderResult(order, result, err))
	}

	placed, failed := 0, 0
	for _, row := range results {
		if ok, _ := row["status"].(bool); ok {
			placed++
		} else {
			failed++
		}
	}
	return map[string]any{
		"status":  failed == 0,
		"placed":  placed,
		"failed":  failed,
		"results": results,
		"session": session,
	}, nil
}

func (c *Client) book(ctx context.Context, cc ClientCreds, path, key string) (map[string]any, error) {
	session, err := c.sessionOrLogin(ctx, cc)
	if err != nil {
		return nil, fmt.Errorf("Angel session unavailable for %s", key)
	}

	headers := c.smartHeaders(cc.APIKey)
	result, err := c.doJSON(ctx, "GET", path, authHeaders(headers, session.JWTToken), nil)
	if err != nil {
		relogin, rerr := c.AutoLogin(ctx, withoutSession(cc))
		if rerr != nil {
			return nil, err
		}
		session = sessionFromResponse(relogin)
		result, err = c.doJSON(ctx, "GET", path, authHeaders(headers, session.JWTToken), nil)
		if err != nil {
			return nil, err
		}
	}

	return map[string]any{
		"status":  true,
		key:       normalizeBookRows(result["data"]),
		"raw":     result,
		"session": session,
	}, nil
}

func normalizeBookRows(v any) []map[string]any {
	switch rows := v.(type) {
	case []any:
		out := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			if m, ok := row.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	case []map[string]any:
		return rows
	case map[string]any:
		return []map[string]any{rows}
	default:
		return []map[string]any{}
	}
}

func placeOrderPayload(leg Leg) (map[string]any, error) {
	if leg.Token == "" {
		return nil, fmt.Errorf("token missing")
	}
	if leg.Symbol == "" {
		return nil, fmt.Errorf("trading symbol missing")
	}
	units := int(math.Trunc(leg.Qty * maxFloat(leg.LotSize, 1)))
	if units <= 0 {
		return nil, fmt.Errorf("quantity must be greater than zero")
	}

	orderType := placeOrderType(leg.OrderType)
	price := 0.0
	trigger := math.Max(0, leg.TriggerPrice)
	if orderType == "LIMIT" || orderType == "STOPLOSS_LIMIT" {
		price = math.Max(0, leg.Price)
		if price <= 0 {
			return nil, fmt.Errorf("price required for %s", orderType)
		}
	}
	if orderType == "STOPLOSS_LIMIT" || orderType == "STOPLOSS_MARKET" {
		if trigger <= 0 {
			return nil, fmt.Errorf("trigger price required for %s", orderType)
		}
	}

	return map[string]any{
		"variety":         "NORMAL",
		"tradingsymbol":   leg.Symbol,
		"symboltoken":     leg.Token,
		"transactiontype": tradeType(leg.TradeType),
		"exchange":        orDefault(leg.Exchange, "NFO"),
		"ordertype":       orderType,
		"producttype":     mapProductType(leg.ProductType),
		"duration":        "DAY",
		"price":           priceString(price),
		"triggerprice":    priceString(trigger),
		"squareoff":       "0",
		"stoploss":        "0",
		"quantity":        strconv.Itoa(units),
		"ordertag":        "alphahedge_basket",
	}, nil
}

func placeOrderType(v string) string {
	t := strings.ToUpper(strings.TrimSpace(v))
	switch t {
	case "LIMIT", "LMT":
		return "LIMIT"
	case "SL", "STOPLOSS_LIMIT":
		return "STOPLOSS_LIMIT"
	case "SL-M", "SLM", "STOPLOSS_MARKET":
		return "STOPLOSS_MARKET"
	default:
		return "MARKET"
	}
}

func priceString(v float64) string {
	if v <= 0 {
		return "0"
	}
	return strconv.FormatFloat(math.Round(v*100)/100, 'f', 2, 64)
}

func placeLegLabel(leg Leg) string {
	return strings.TrimSpace(strings.Join([]string{leg.Exchange, leg.Symbol, tradeType(leg.TradeType)}, " "))
}

func placeOrderResult(order, result map[string]any, err error) map[string]any {
	row := map[string]any{
		"request": map[string]any{
			"tradingsymbol":   order["tradingsymbol"],
			"symboltoken":     order["symboltoken"],
			"transactiontype": order["transactiontype"],
			"exchange":        order["exchange"],
			"ordertype":       order["ordertype"],
			"producttype":     order["producttype"],
			"quantity":        order["quantity"],
			"price":           order["price"],
			"triggerprice":    order["triggerprice"],
		},
	}
	if err != nil {
		row["status"] = false
		row["error"] = err.Error()
		return row
	}
	if ok, _ := result["status"].(bool); !ok {
		row["status"] = false
		row["error"] = strOr(result["message"], "Order rejected")
		row["raw"] = result
		return row
	}
	data := mapData(result)
	row["status"] = true
	row["orderid"] = strOr(data["orderid"], strOr(result["orderid"], ""))
	row["uniqueorderid"] = strOr(data["uniqueorderid"], "")
	row["raw"] = result
	return row
}
