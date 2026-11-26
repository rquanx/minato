# Calls and Usage benchmark

The local PostgreSQL 17 benchmark used 300,000 synthetic calls over 30 days, 360,000 model attempts and one extra call in a second environment. The fixture supplied two 4 KiB audit bodies for 10% of calls. The mixed run added 200 audit writes through the durable SQLite journal with eight writers while report and search queries ran.

| Operation | Local p95 |
| --- | ---: |
| Recent calls | 4 ms |
| Calls filtered by minimum tokens | 140 ms |
| Usage grouped by model over 30 days | 1,872 ms |
| Project monthly trend from call details | 2,089 ms |
| Project monthly trend with hourly summaries | 125 ms |
| Audit write during concurrent queries | 46 ms |

The main tables and their indexes occupied about 667 MiB, including about 328 MiB for audit content. These are fixture measurements. Disk consumption varies with call rate, retention, audit body size and capture rate. The test compares project counts, tokens and cost against the report calculated from call details. Percentiles derived from hourly summaries use 50 ms buckets.

Grouped model usage still reads individual attempts. It was the slowest remaining query, and model-level hourly aggregation is the next candidate if this query exceeds the deployment's latency target.

Use a dedicated local PostgreSQL database with no existing Minato data. Set `DATABASE_URL` for that database, then run the following commands. Set `MINATO_LOAD_CALLS` to change the fixture size.

```bash
bun run db:migrate
bun tools/usage-load.ts
```
