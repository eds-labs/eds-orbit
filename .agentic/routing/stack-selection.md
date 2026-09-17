# Stack Selection Routing

Nutze diese Datei, wenn eine neue Anwendung, ein neues Modul oder ein neuer Service geplant wird.

## Auswahlkriterien

1. Zielplattform
   - web
   - backend
   - ios
   - android
   - macos
   - windows
   - linux
   - desktop-cross-platform
   - mobile-cross-platform
   - data
   - cli
   - automation
   - ai-agent-app

2. Betriebsmodell
   - managed-backend
   - custom-backend
   - serverless
   - containerized
   - offline-first
   - enterprise-managed
   - local-first

3. Team-Skills
   - typescript
   - python
   - go
   - rust
   - swift
   - kotlin
   - csharp
   - dart

4. Priorität
   - speed-to-market
   - maintainability
   - native-ux
   - performance
   - compliance
   - offline-capability
   - low-bundle-size
   - ecosystem-maturity

## Default-Routing

| Situation | Preset |
|---|---|
| Web-App, SaaS, MVP, Auth, Storage, Realtime | `web-next-supabase.yaml` |
| Web-App, eigenes Backend, klare API-Grenze | `web-next-custom-postgres.yaml` |
| Reine Backend-API, TypeScript, schlank | `backend-fastify-postgres.yaml` |
| Reine Backend-API, Enterprise/DDD/Module | `backend-nest-postgres.yaml` |
| Python API, AI/ML-nahe Services | `backend-fastapi-postgres.yaml` |
| iOS + Android, TypeScript/React-Team | `mobile-expo-supabase.yaml` |
| iOS + Android + Desktop/Web, ein UI-Stack | `multiplatform-flutter.yaml` |
| Android/iOS mit Kotlin-Team und geteilter Business-Logik | `multiplatform-kmp-compose.yaml` |
| Apple-only, beste native UX | `native-apple-swiftui.yaml` |
| Android-only, beste native Android UX | `native-android-kotlin-compose.yaml` |
| Windows-only, native Windows UX | `native-windows-winui.yaml` |
| Desktop Mac/Windows/Linux, Web-UI + kleine Binaries | `desktop-tauri-react.yaml` |
| Desktop Mac/Windows/Linux, maximale Web/Node-Kompatibilität | `desktop-electron-react.yaml` |
| .NET-Team, Desktop + Mobile | `multiplatform-dotnet-maui.yaml` |
| .NET-Team, Desktop-first Win/Mac/Linux | `desktop-avalonia.yaml` |
| Datenpipeline mit Assets/Lineage/Observability | `data-pipeline-dagster.yaml` |
| Batch-orchestrierte Workflows mit etabliertem Ökosystem | `data-pipeline-airflow.yaml` |
| CLI in Go | `cli-go-cobra.yaml` |
| CLI in Python | `cli-python-typer.yaml` |
| CLI in Rust | `cli-rust-clap.yaml` |

## Entscheidungsempfehlung

Bevorzugung:

1. Für neue SaaS-Webprojekte: Next.js + Postgres/Supabase.
2. Für AI- und Daten-nahe Services: Python/FastAPI oder TypeScript/Hono/Fastify.
3. Für mobile Apps mit Web-Team: Expo/React Native.
4. Für native Premium-UX: SwiftUI auf Apple, Kotlin/Compose auf Android.
5. Für Desktop mit Web-Stack und geringem Overhead: Tauri.
6. Für Desktop mit vielen Node-/Browser-APIs oder großem Web-App-Reuse: Electron.
7. Für Enterprise-.NET-Teams: MAUI oder Avalonia.
