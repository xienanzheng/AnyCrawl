# AnyCrawl Research Dashboard

A lightweight Vite + React UI that talks to your self-hosted AnyCrawl API (`http://localhost:8080` by default). The dashboard is now intent-driven: connect your keys once, pick a template (Google Flights or Expedia Hotels), and the app crawls/scrapes the relevant URLs before piping the JSON into your preferred LLM (OpenAI-compatible or Gemini) for a traveler-friendly summary.

## Quick start

```bash
cd apps/dashboard
pnpm install
pnpm dev
```

Visit http://localhost:5175, enter your AnyCrawl base URL + API key (stored locally), then:

1. (Optional) Provide OpenAI or Gemini LLM credentials + prompt so summaries run automatically.
2. Select an intent (Google Flights date-range scan or Expedia Hotels multi-night scan).
3. Fill in the required fields (origins, destinations, date windows, etc.).
4. Click “Run” — the dashboard will build the correct flight/hotel URLs, scrape them through AnyCrawl, and show both the raw JSON and the simplified LLM response.

The UI retries each API call once before surfacing actionable errors and wraps all responses inside `{ status, summary, data }` result cards to make copying results into agents easier.
