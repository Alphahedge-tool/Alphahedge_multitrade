package upstox

import "strconv"

// NeedsLogin signals that no live session exists and the user must complete the
// one-click browser OAuth. The handler turns this into a 200 response carrying
// {status:false, needsLogin:true, loginUrl} so the frontend can open the URL.
type NeedsLogin struct {
	LoginURL string
}

func (e *NeedsLogin) Error() string { return "Upstox login required" }

// strOr returns v as a string, or the fallback if v is nil / not a string.
func strOr(v any, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

// toFloat coerces JSON numbers (float64) or numeric strings to float64.
func toFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}
