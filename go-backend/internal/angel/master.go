package angel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"angelone-backend/internal/config"
)

// ScripRow is the slim per-contract record we keep in memory (mirrors the Node
// slimData shape: t=token, s=symbol, n=name, e=expiry, k=strike, g=segment,
// l=lotsize).
type ScripRow struct {
	Token   string  `json:"t"`
	Symbol  string  `json:"s"`
	Name    string  `json:"n"`
	Expiry  string  `json:"e"`
	Strike  float64 `json:"k"`
	Segment string  `json:"g"`
	LotSize int     `json:"l"`
}

// MasterStore owns the scrip master: the slim rows, the symbol→expiries index,
// and freshness. All reads go through Data()/Index() which lazily (and, via
// singleflight, exactly once under concurrency) load or refresh.
type MasterStore struct {
	cfg config.Config

	mu       sync.RWMutex
	rows     []ScripRow
	index    map[string][]string
	loadedAt time.Time

	group singleflight.Group // de-dupes concurrent loads/refreshes
}

// neededSpotSymbols are the index cash-segment names we keep for spot LTP.
var neededSpotSymbols = map[string]bool{
	"Nifty 50": true, "Nifty Bank": true, "Nifty Fin Service": true,
	"Nifty Mid Select": true, "SENSEX": true,
}

func NewMasterStore(cfg config.Config) *MasterStore {
	return &MasterStore{cfg: cfg, index: map[string][]string{}}
}

// Data returns the slim rows, loading/refreshing if the cache is cold or stale.
func (m *MasterStore) Data(ctx context.Context) ([]ScripRow, error) {
	if err := m.ensure(ctx); err != nil {
		return nil, err
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.rows, nil
}

// Index returns the symbol→[expiries] dropdown index.
func (m *MasterStore) Index(ctx context.Context) (map[string][]string, error) {
	if err := m.ensure(ctx); err != nil {
		return nil, err
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.index, nil
}

// Warm proactively loads the master (called on boot so the first chain is fast).
func (m *MasterStore) Warm(ctx context.Context) error { return m.ensure(ctx) }

// SearchResult is one FUT/OPT contract matched by the basket search box.
type SearchResult struct {
	Token         string `json:"token"`
	TradingSymbol string `json:"tradingSymbol"`
	Name          string `json:"name"`
	Expiry        string `json:"expiry"` // master form, e.g. "07JUL2026"
	Strike        int    `json:"strike"` // 0 for futures
	OptionType    string `json:"optionType"` // CE | PE | FUT
	Exchange      string `json:"exchange"`   // NFO | BFO | MCX
	LotSize       int    `json:"lotSize"`
	Instrument    string `json:"instrument"` // OPT | FUT
}

// SearchScrips finds FUT/OPT contracts matching a free-text query (only futures
// and options — never cash). Every whitespace-separated token must appear in the
// contract's trading symbol or underlying name, so "nifty 24050 ce" narrows to
// that strike. Results are ordered: best name match first, then FUT before OPT,
// then NEAREST EXPIRY first, then strike, then CE before PE.
func (m *MasterStore) SearchScrips(ctx context.Context, query string, limit int) ([]SearchResult, error) {
	q := strings.ToUpper(strings.TrimSpace(query))
	if q == "" {
		return []SearchResult{}, nil
	}
	if limit <= 0 {
		limit = 80
	}
	tokens := strings.Fields(q)
	primary := tokens[0]

	rows, err := m.Data(ctx)
	if err != nil {
		return nil, err
	}

	type scored struct {
		r         SearchResult
		nameScore int   // 0 exact underlying, 1 prefix, 2 contains
		instOrder int   // FUT 0, OPT 1
		expiryMs  int64 // nearest first
	}
	var out []scored
	for i := range rows {
		row := &rows[i]
		sym := strings.ToUpper(row.Symbol)

		var optType, instrument string
		switch {
		case strings.HasSuffix(sym, "CE"):
			optType, instrument = "CE", "OPT"
		case strings.HasSuffix(sym, "PE"):
			optType, instrument = "PE", "OPT"
		case strings.HasSuffix(sym, "FUT"):
			optType, instrument = "FUT", "FUT"
		default:
			continue // skip cash / anything that isn't a future or option
		}

		name := strings.ToUpper(row.Name)
		matched := true
		for _, t := range tokens {
			if !strings.Contains(sym, t) && !strings.Contains(name, t) {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}

		nameScore := 2
		if name == primary {
			nameScore = 0
		} else if strings.HasPrefix(name, primary) {
			nameScore = 1
		}
		instOrder := 1
		strike := 0
		if instrument == "FUT" {
			instOrder = 0
		} else {
			strike = normalizeStrike(row.Strike, row.Segment)
		}
		out = append(out, scored{
			r: SearchResult{
				Token:         row.Token,
				TradingSymbol: row.Symbol,
				Name:          row.Name,
				Expiry:        row.Expiry,
				Strike:        strike,
				OptionType:    optType,
				Exchange:      row.Segment,
				LotSize:       row.LotSize,
				Instrument:    instrument,
			},
			nameScore: nameScore,
			instOrder: instOrder,
			expiryMs:  parseExpiryMs(row.Expiry),
		})
	}

	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.nameScore != b.nameScore {
			return a.nameScore < b.nameScore
		}
		if a.instOrder != b.instOrder {
			return a.instOrder < b.instOrder
		}
		if a.expiryMs != b.expiryMs {
			return a.expiryMs < b.expiryMs // nearest expiry first
		}
		if a.r.Strike != b.r.Strike {
			return a.r.Strike < b.r.Strike
		}
		return a.r.OptionType < b.r.OptionType // CE before PE
	})

	res := make([]SearchResult, 0, min(limit, len(out)))
	for i := 0; i < len(out) && i < limit; i++ {
		res = append(res, out[i].r)
	}
	return res, nil
}

func (m *MasterStore) fresh() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.rows) > 0 && time.Since(m.loadedAt) < config.MasterTTL
}

// ensure loads from disk (if fresh) or downloads from Angel. singleflight
// collapses concurrent first-loads into one.
func (m *MasterStore) ensure(ctx context.Context) error {
	if m.fresh() {
		return nil
	}
	_, err, _ := m.group.Do("load", func() (any, error) {
		if m.fresh() {
			return nil, nil
		}
		if m.loadFromDisk() {
			return nil, nil
		}
		return nil, m.download(ctx)
	})
	return err
}

// loadFromDisk populates the cache from the slim files if they exist and are
// within TTL. Returns true on success.
func (m *MasterStore) loadFromDisk() bool {
	stat, err := os.Stat(m.cfg.MasterFile)
	if err != nil || time.Since(stat.ModTime()) >= config.MasterTTL {
		return false
	}
	rawMaster, err := os.ReadFile(m.cfg.MasterFile)
	if err != nil {
		return false
	}
	rawIndex, err := os.ReadFile(m.cfg.IndexFile)
	if err != nil {
		return false
	}
	var rows []ScripRow
	var index map[string][]string
	if json.Unmarshal(rawMaster, &rows) != nil || json.Unmarshal(rawIndex, &index) != nil {
		return false
	}
	m.mu.Lock()
	m.rows, m.index, m.loadedAt = rows, index, time.Now()
	m.mu.Unlock()
	return true
}

// Refresh forces a re-download and returns a small summary (for /refresh-master).
func (m *MasterStore) Refresh(ctx context.Context) (map[string]any, error) {
	res, err, _ := m.group.Do("refresh", func() (any, error) {
		if err := m.download(ctx); err != nil {
			return nil, err
		}
		m.mu.RLock()
		defer m.mu.RUnlock()
		return map[string]any{
			"status":      true,
			"symbolCount": len(m.index),
			"totalTokens": len(m.rows),
		}, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(map[string]any), nil
}

// download fetches the full master, slims it to derivatives + needed spots,
// builds the expiry index, writes both slim files, and updates the cache.
func (m *MasterStore) download(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", config.MasterURL, nil)
	if err != nil {
		return err
	}
	// The master is ~8.8 MB; give it a generous timeout independent of API calls.
	httpClient := &http.Client{Timeout: 60 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Master download failed: HTTP %d", resp.StatusCode)
	}

	// Stream-decode the array to keep peak memory reasonable.
	dec := json.NewDecoder(resp.Body)
	dec.UseNumber()
	if _, err := dec.Token(); err != nil { // opening '['
		return err
	}

	rows := make([]ScripRow, 0, 200_000)
	indexSet := map[string]map[string]bool{}
	for dec.More() {
		var raw map[string]any
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		seg, _ := raw["exch_seg"].(string)
		name, _ := raw["name"].(string)
		isDerivative := seg == "NFO" || seg == "BFO" || seg == "MCX"
		isNeededSpot := (seg == "NSE" || seg == "BSE") && neededSpotSymbols[name]
		if !isDerivative && !isNeededSpot {
			continue
		}
		expiry := strings.ToUpper(strOr(raw["expiry"], ""))
		lot := int(toFloat(raw["lotsize"]))
		if lot == 0 {
			lot = 1
		}
		rows = append(rows, ScripRow{
			Token:   strOr(raw["token"], ""),
			Symbol:  strOr(raw["symbol"], ""),
			Name:    name,
			Expiry:  expiry,
			Strike:  toFloat(raw["strike"]),
			Segment: seg,
			LotSize: lot,
		})
		if isDerivative && expiry != "" {
			if indexSet[name] == nil {
				indexSet[name] = map[string]bool{}
			}
			indexSet[name][expiry] = true
		}
	}

	index := make(map[string][]string, len(indexSet))
	for name, set := range indexSet {
		list := make([]string, 0, len(set))
		for e := range set {
			list = append(list, e)
		}
		sort.Slice(list, func(i, j int) bool { return parseExpiryMs(list[i]) < parseExpiryMs(list[j]) })
		index[name] = list
	}

	// Persist slim files (best-effort; cache is authoritative in memory).
	if data, err := json.Marshal(rows); err == nil {
		_ = os.WriteFile(m.cfg.MasterFile, data, 0o644)
	}
	if data, err := json.Marshal(index); err == nil {
		_ = os.WriteFile(m.cfg.IndexFile, data, 0o644)
	}

	m.mu.Lock()
	m.rows, m.index, m.loadedAt = rows, index, time.Now()
	m.mu.Unlock()
	return nil
}
