# Hosting Decision

Checkpoint: 2026-09-17. The implementation uses self-hosted PostgreSQL with pgvector as an explicit adaptation of the managed-hosting preset. No host purchase, resize, deployment, consolidation or cancellation was performed.

## Current decision

Keep Orbit development independent and keep Desk and Forecast on separate failure/security domains. The observed services VPS already hosts Postiz/Temporal/Elasticsearch, Matomo and Chatwoot on 4 GiB; its sampled RAM peak of 3.56 GiB leaves about 11% nominal reserve before adding Orbit. Adding Orbit/RAG there unchanged is unsupported. The other observed hosts are not spare consolidation capacity.

Plan around 32 GiB RAM, approximately 8–12 modern execution units and 500 GB–1 TB NVMe, retaining 25–30% measured reserve. This is a budgeting envelope, not a benchmark or capacity promise. A 64 GiB alternative needs measured concurrency/data growth or an explicit reserve decision. CPU labels across providers are not equivalent measurements.

The checked netcup RS4000 G12 public offer is a conditional quote candidate because its 1 TB disk fits the planned envelope. Hostinger remains an alternative subject to a real resize/contract quote; the checked KVM8 disk specification misses the 500 GB baseline. Public advertisements are separate from actual contracts, discounts, taxes, backup/add-on costs and cancellation terms. No savings or host-count reduction is established, particularly if Chatwoot remains on the source host.

## Evidence and release boundary

The read-only inventory, bounded metrics, public cost comparison and conditional recommendation are complete in `VPS_INVENTORY.md`, `RESOURCE_AND_COST_COMPARISON.md` and `CONSOLIDATION_RECOMMENDATION.md`. Their missing contract, workload, backup and version evidence remains explicit.

Both new isolated local Linux ARM64 Compose variants passed fresh migrations, application health, authenticated HTTPS, non-root/read-only runtime, cgroup limits and PNG rendering (`docs/evidence/container-acceptance.json`). Those results establish a tested local deployment shape; they do not size the proposed shared host or establish production I/O, noisy-neighbor, AMD64, firewall or availability guarantees.

Before a purchase/release: obtain the exact provider/region/CPU/disk/term/add-on quote and real existing contracts; measure representative Orbit/RAG plus incumbent workload overlap; verify independent encrypted backups and service-specific restore; name owners and migration windows; approve the exact order and each subsequent service cutover. Orbit receives no Docker socket, root SSH or global host administration. Use separate projects/networks and private databases/queues with one approved ingress topology. Follow `DEPLOYMENT_BOOTSTRAP.md` and the explicitly unexecuted migration plan only after the relevant authorization.
