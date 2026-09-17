# Consolidation recommendation — conditional

Date:2026-09-17. Basis: [inventory](VPS_INVENTORY.md), [resources/costs](RESOURCE_AND_COST_COMPARISON.md). This is planning, not infrastructure authorization.

Keep Desk and Forecast separate. Continue Orbit implementation/testing independently. Plan32GB,about8–12 modern execution units and500GB–1TB NVMe with25–30% measured reserve; migrate eligible existing services individually only after owner, backup and restore gates.

Current services1269962 already runs Postiz/Temporal/Elasticsearch,Matomo andChatwoot on4GiB. Sampled RAM peak3.56GiB leaves~11% nominal reserve before Orbit. Adding Orbit/RAG there as-is is unsupported. Other current listed hosts are Forecast's DNS destination and a Desk workload, not free consolidation capacity.

Among checked32GB public offers, netcup RS4000G12 is the leading quote candidate because1TB meets the master envelope. Provider/region/stock/CPU semantics, backup and monitoring costs still need acceptance. It is KVM with advertised dedicated resources, not bare metal. Existing Hostinger remains credible for operational familiarity, but KVM8's400GB misses the target baseline and resize terms/options need a real quote. Control-plane availability is separate from application operating safety; isolated API errors do not establish a reliability ranking.

No purchase follows from this recommendation. Only one eligible services VPS was found, already consolidated. A host-count reduction or monetary saving cannot currently be claimed. If Chatwoot stays, retain the source contract in the cost model.

## Alternatives

64GB is justified only by representative concurrency exceeding the32GB budget, greater data/index growth or a conscious reserve choice. Checked alternatives include netcup RS8000G12(KVM) and HetznerAX42-1(physical). CPU labels are not interchangeable benchmarks. Neither automatically authorizes Forecast consolidation. Extra RAM does not remove shared-host failure or replace independent backups.

Keeping the current services host unchanged while Orbit remains development-only is the immediate safe state. An in-place resize is a future alternative requiring exact quote/storage fit/downtime and recovery evidence; it was not performed.

## Service and authority boundaries

| Service | Proposed treatment |
| --- | --- |
| Orbit |Independent development now; later isolated deployment with real publishing/spend/connector writes gated separately |
| Postiz |Full observed stack plus media/integration state; exactly one active publisher |
| Matomo |After site IDs/tracking/MariaDB/plugins/files/archive schedule are verified |
| Chatwoot |Discovered source resident; ownership/privacy/migration scope decision required |
| MCP/webhooks/sites |Only after actual endpoints/owners/callback/discovery mapping |
| Desk/Forecast |Separate security/failure domains; no migration here |
| FamilyPlan/Supabase |No implied platform move |

Use separate Compose projects/networks, private databases/queues, scoped service users, resource/concurrency budgets and shared Caddy ingress. Orbit must receive no Docker socket/root SSH/global administration. Backups and availability monitoring must survive loss of the services host. Kubernetes/additional hypervisor are not needed for this initial target.

Before selection becomes executable: verify real contract/termination data; resolve residents/digests/volume sizes/limits/OOM/job overlap; verify restore and owner-agreed RPO/RTO; validate representative Orbit/RAG capacity; approve exact provider/region/tariff/term/add-ons/order; approve each subsequent deployment/migration/DNS/cutover individually. No last-minute publishing/analytics migration around the plannedSeptember19 presale is assumed.
