# Resource and cost comparison

Status: planning evidence, 2026-09-17. Sources I 1–I 6 are defined in [inventory](VPS_INVENTORY.md). No purchase, resize, migration or monitoring installation occurred.

## Existing historical measurements

P95 uses nearest-rank sorted[ceil(0.95*n)-1] over finite samples. RAM/disk API bytes are converted to GiB(2^30). Provider CPU percentages are not benchmarks or physical-core entitlement. Approximately30-minute samples can miss short spikes/OOM events; these are sample quantiles, not time-weighted quantiles.

| Host | Actual UTC coverage / samples | CPU P 95 / max | RAM P 95 / max GiB | Last disk used / change GiB |
| --- | --- | --- | --- | --- |
| 1269962 services | Sep 03 00:17:36–Sep 17 11:19:26 /694 |19.23% /73.61% |3.44 /3.56 |23.89 /+2.59 |
| 1284853 Forecast DNS destination | Sep 13 13:47:54–Sep 17 11:18:26 /188 |33.40% /60.99% |2.60 /2.69 |10.86 /+9.34 |
| 1286926 Desk boundary | Sep 03 00:16:18–Sep 17 11:15:41 /695 |19.21% /28.39% |2.04 /2.09 |36.53 /+0.108 |

Original request: Sep03–Sep17 11:23UTC. Forecast HTTP500 was followed once by a Sep10–Sep17 request; returned data starts Sep13, so it is neither seven nor fourteen days. Forecast median interval1806s, maximum gap2086s. Disk delta includes unknown downloads/deployments and cannot be extrapolated as organic monthly growth. No training/backtest was started or attributed from host metrics.

Services RAM sampled peak is about89% of nominal4GiB, leaving11% before Orbit; OS-visible capacity is smaller. This fails the25–30% reserve target. Provider RAM semantics do not distinguish reclaimable cache/working set. CPU spare capacity does not resolve memory pressure. Host uptime resets appear for services/Forecast; causes uninvestigated and unrelated to this audit.

Missing: historical swap/OOM, I/O wait/latency, DB load, process working sets, queue/job duration/overlap and Matomo archival duration. HTTP traffic cannot substitute for archival load.

## Proposed Orbit envelope — assumptions only

Target:32GiB services host, about8–12 modern CPU execution units and500GB–1TB NVMe. No local GPU/LLM, continuous video rendering or Forecast training is included. Limits below are proposed planning budgets, not production measurements or applied configuration.

| Allocation | RAM budget | Notes |
| --- | ---: | --- |
| Orbit web/API/ordinary workers |3GiB | Bounded concurrency |
| Orbit PostgreSQL/pgvector/full text |4GiB | Measure cache/index working set |
| Parsing/ingest/embedding workers |2GiB | One heavy parse/reindex initially; API embeddings need no local GPU |
| Complete observed Postiz stack |5 GiB | Include Temporal, Elasticsearch, both DBs, Redis and auxiliary components |
| Matomo/MariaDB/archive |2GiB | Schedule away from indexing peaks |
| Chatwoot, if separately in scope |2 GiB | Otherwise retain original source cost |
| OS/Caddy/local observability/sites |3GiB | No Orbit global Docker/host control |
| Unallocated reserve |11 GiB (34%) | Acceptance requires at least 25–30% reserve at intended concurrent load |

Knowledge example:10,000 active documents×50chunks=500,000chunks; up to three full versions if retention permits. At1536 float32 dimensions, raw vectors=3.072GB/2.86GiB per version,8.58GiB for three. This excludes index overhead, text, relational data, WAL and rebuild copies. Dimensions are an assumption. At2MiB/source, source files add19.5GiB/version or58.6GiB for three; large PDFs/media invalidate the average.

Illustrative500GB disk budget:100GB sources/history,60GB DB/vector/text/index/rebuild,100GB other data/media,40GB images/logs/temp, at least150GB free. Actual source DB/media sizes remain missing;1TB is less constrained. Separate encrypted off-host backup storage must account for all data, retention and churn. Local snapshots are not independent backups.

## Actual contracts — unavailable

1269962 KVM1,1284853 KVM2,1286926 KVM1 plans are verified. Actually paid monthly equivalents, VAT, term, renewal price/date and cancellation deadlines are unknown for all. The separate Desk alias has no established contract here. Public offers are not user bills. No source is counted as cancellable until all residents and contractual conditions are resolved; retaining Chatwoot prevents claiming the whole services-host fee as savings.

## Public offers retrieved 2026-09-17

Planning quotes only: no order/cart/reservation, no reliability ranking. Final tax, stock, CPU entitlement, terms and backup quote need verification before a purchase decision.

| Candidate | Resources / CPU semantics | Public pricing | Fit and limits |
| --- | --- | --- | --- |
| Hostinger KVM8 |8vCPU,32GB,400GB NVMe |€21.99/month advertised; renewal€49.99/month for2years; prepaid. Initial term/tax status not established from retrieved text; weekly provider backups advertised included |Familiar provider; disk below500GB–1TB baseline. Actual resize quote, downtime, storage options and core entitlement unknown |
| netcup RS4000G12 12-month |32GB ECC,12 advertised dedicated CPU units,1TB NVMe; KVM VM, not bare metal |€39.92/month incl19%VAT;12-month minimum/billing;€0setup; baseline Europe-any/IPv4+IPv6 |Meets nominal envelope; physical-core/SMT semantics require confirmation |
| netcup RS8000G12 reserve |64GB ECC,16 advertised dedicated CPU units,2TB NVMe; KVM |€71.36/month incl19%VAT,12-month public listing |Reserve not currently justified by measured services load alone |
| Hetzner AX42-1 physical alternative |64GB DDR5,Ryzen7PRO8700GE,2×512GBNVMe; whole server |€97.30/month exclVAT/IPv4;€49setup in current price table;Falkenstein/Helsinki |Mirroring yields roughly one drive capacity; full terms/network/backup quote incomplete |

Sources: [Hostinger](https://www.hostinger.com/de/vps), [netcup overview](https://www.netcup.com/de/server/root-server), [RS4000 exact12-month product](https://www.netcup.com/de/server/root-server/rs-4000-g12-ip-12m), [RS8000 exact12-month product](https://www.netcup.com/de/server/root-server/rs-8000-g12-ip-12m), [AX42 configurator](https://www.hetzner.com/dedicated-rootserver/ax42/configurator/), [Hetzner official June2026 price table updatedJuly8](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/).

RS4000 lists +€8.01/month for1-month term and +€6.01/month for chosen Nuremberg/Vienna. Europe-any can beAT/DE/NL. Product shows location-unavailable/capacity-delay notices, so provisioning availability is unconfirmed. Another netcup overview returned different headlines; this table uses the exact linked12-month product. Cancellation notice/renewal terms remain unverified.

Off-host backup cost is unknown, not zero. [Hetzner Storage Box](https://www.hetzner.com/storage/storage-box/) confirms a1TB tier andDE/FI locations but monetary values were absent in fetched text. Independent monitoring/alert cost is also unknown. Provider backups and an on-host monitor do not establish independent recovery/availability monitoring.

## Cost model and decision gate

On a consistent tax/currency basis, monthly saving=A−N−B−M, whereA=proven cancellable old services contracts,N=new services host,B=additional off-host backup,M=external monitoring. Desk and unchanged Forecast cancel from both sides. One-timeU includes labor/setup/contract overlap/temp storage/network. Payback=U/monthly saving only if saving is positive. MissingA,B,M,terms/labor preclude numeric saving/payback claims.

Only one eligible existing services VPS was found, already consolidated. A32GB replacement may increase spending while enabling Orbit/reserve. Capacity and maintainability are the supported rationale; savings are unproven.

Before execution: obtain sanitized contract evidence; resolve Chatwoot and Desk identities; read resource limits/DB/media sizes; obtain7–14d existing per-service/job-overlap evidence; define RPO/RTO and verify off-host restore. Any new monitoring installation requires its own approved change and was not started.
