# Projektstruktur: Web Next.js + Supabase

```txt
.
├── AGENTS.md
├── package.json
├── next.config.ts
├── src/
│   ├── app/
│   │   ├── (marketing)/
│   │   ├── (auth)/
│   │   ├── (app)/
│   │   ├── api/
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ui/
│   │   └── feature/
│   ├── features/
│   │   └── <feature>/
│   │       ├── components/
│   │       ├── actions/
│   │       ├── queries/
│   │       ├── schemas/
│   │       └── tests/
│   ├── lib/
│   │   ├── supabase/
│   │   ├── auth/
│   │   ├── db/
│   │   └── utils/
│   └── styles/
├── supabase/
│   ├── migrations/
│   ├── functions/
│   └── seed.sql
├── tests/
│   ├── unit/
│   └── e2e/
└── .agentic/
```

## Codex-Regeln

- Server Components als Default, Client Components nur bei Interaktion, Browser APIs oder lokalem UI-State.
- Datenzugriff zentral über `src/lib/supabase` oder `src/lib/db`.
- RLS-Policies bei Supabase immer mitdenken.
- Keine Secrets in Client Components.
- Jede neue User Journey braucht Loading, Empty und Error State.
