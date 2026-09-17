# Deployment Preset: AWS ECS + RDS

## Geeignet für

- production-grade APIs
- Enterprise-Setups
- Teams mit AWS-Kompetenz
- Workloads mit klaren Netzwerk-/Compliance-Anforderungen

## Typische Bausteine

- ECS/Fargate für App und Worker
- RDS Postgres
- ElastiCache/Redis optional
- ALB
- CloudWatch Logs/Metrics
- Secrets Manager
- S3 für Storage

## Pflichtchecks

- VPC/Subnets/Security Groups
- IAM Least Privilege
- RDS Backups und Maintenance Window
- Migrationsstrategie
- Blue/Green oder Rolling Deployment
- Alarme für Fehler, Latenz und Ressourcen
- IaC bevorzugt statt manueller Console-Klicks
