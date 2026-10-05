# uLiquid website retrieval evaluation — review sheet

Dataset `evals/knowledge/uliquid-website-2026-10-05.v1.json` for the live index evaluation of the uLiquid project (Orbit knowledge index, ADR 0007/RAG gate). Prepared by Claude on 2026-10-05 from the 44 chunks of website document version 2 (fetched 2026-10-05 15:21 UTC); **to be reviewed and confirmed by Mario before use** (independent labeling).

- 54 cases with expected chunks (gate: at least 48, recall@10 at least 0.9).
- 14 negative safeguard cases (gate: at least 12, zero forbidden hits): German queries against an English-only corpus, and queries dated before the current version was valid.
- A case passes when any expected chunk is among the 10 nearest chunks. Several expected chunks are listed where the website states the same thing in more than one place.

Please check for each row: does the listed chunk really answer the question, and is an obviously better chunk missing?

| ID | Query | Expected chunks | Negative case |
| --- | --- | --- | --- |
| pos-01 | Does each trading bot get its own on-chain vault? | #0 Bot Vaults feature card, #29 One bot, one vault on HyperEVM |  |
| pos-02 | Where are bot vaults deployed and are bot funds kept separate? | #29 One bot, one vault on HyperEVM, #0 Bot Vaults feature card, #24 Hyperliquid: perps, spot, HyperEVM |  |
| pos-03 | What does the dashboard show about balances, positions and PnL? | #3 Dashboard & Portfolio |  |
| pos-04 | Does the portfolio view warn me when data is out of date? | #3 Dashboard & Portfolio |  |
| pos-05 | Where can I see charts, news and the economic calendar? | #4 Market Intelligence |  |
| pos-06 | Can I see funding rates and open interest? | #4 Market Intelligence |  |
| pos-07 | Can I practise with paper trading before trading live? | #5 Trading Desk, #28 BingX, planned exchanges, paper trading simulation |  |
| pos-08 | Is there a review step before an order goes live? | #5 Trading Desk, #12 Trading: orders you review and approve, #17 Ready for review: nothing executes without approval |  |
| pos-09 | Can I ask the AI about markets and my open positions? | #6 AI Workbench, #8 From noise to insight: AI never places a trade, 16 read-only skills |  |
| pos-10 | Can the AI place a trade on its own? | #8 From noise to insight: AI never places a trade, 16 read-only skills, #17 Ready for review: nothing executes without approval, #22 Review, edit, discard |  |
| pos-11 | How many read-only skills can the AI analyse with? | #8 From noise to insight: AI never places a trade, 16 read-only skills |  |
| pos-12 | What does AI Predictions do? | #9 AI Predictions, #6 AI Workbench |  |
| pos-13 | Which agent explains market moves and shows its sources? | #10 Market Analyst |  |
| pos-14 | Is the Position Copilot read-only? | #11 Position Copilot (read-only) |  |
| pos-15 | Do I approve every order before it is placed? | #12 Trading: orders you review and approve, #5 Trading Desk |  |
| pos-16 | Are bot strategies checked against my risk rules? | #13 Bots: strategies checked against risk rules, #7 Automation & Bots |  |
| pos-17 | Which notification channels are supported? | #14 Notifications: in-app, Telegram, webhook |  |
| pos-18 | Can I get Telegram or webhook notifications? | #14 Notifications: in-app, Telegram, webhook |  |
| pos-19 | Can I describe a trade idea in plain words and get entry and exit rules? | #15 Turn an idea into a structured market workflow |  |
| pos-20 | Does the prediction builder create an automatic trade from my idea? | #16 BTC trend continuation example, reviewable workflow, #17 Ready for review: nothing executes without approval, #15 Turn an idea into a structured market workflow |  |
| pos-21 | Example of a BTC trend continuation idea | #16 BTC trend continuation example, reviewable workflow |  |
| pos-22 | Which timeframe does the example workflow use? | #18 Timeframe 4H |  |
| pos-23 | Example entry conditions with EMA and RSI | #19 Entry conditions: price above 200 EMA, RSI above 55 |  |
| pos-24 | What invalidates the example trade idea? | #20 Invalidation: close below key support, #1 Invalidation and risk rules (illustrative builder) |  |
| pos-25 | How much risk per idea and how many positions in the example risk rules? | #21 Risk rules: 1.0% per idea, max 3 positions, #1 Invalidation and risk rules (illustrative builder) |  |
| pos-26 | Can I edit or discard an AI-structured workflow? | #22 Review, edit, discard, #17 Ready for review: nothing executes without approval |  |
| pos-27 | Which exchanges does uLiquid connect to? | #23 Your exchanges, one desk |  |
| pos-28 | Is live trading enabled separately for each exchange account? | #23 Your exchanges, one desk |  |
| pos-29 | Can I trade perpetuals on-chain on Hyperliquid? | #24 Hyperliquid: perps, spot, HyperEVM, #23 Your exchanges, one desk |  |
| pos-30 | What markets are available on Hyperliquid? | #24 Hyperliquid: perps, spot, HyperEVM |  |
| pos-31 | Does uLiquid support Binance futures? | #25 Binance: spot, USD-M futures |  |
| pos-32 | Which Bitget markets are supported? | #26 Bitget: spot, perpetuals |  |
| pos-33 | Which MEXC markets are supported? | #27 MEXC: spot, perpetuals |  |
| pos-34 | Is BingX supported? | #28 BingX, planned exchanges, paper trading simulation |  |
| pos-35 | Which exchanges are planned next, like OKX or Bybit? | #28 BingX, planned exchanges, paper trading simulation |  |
| pos-36 | How does a bot vault keep funds separate and recoverable? | #29 One bot, one vault on HyperEVM |  |
| pos-37 | Are Bot Vaults already part of a paid plan? | #29 One bot, one vault on HyperEVM |  |
| pos-38 | How is a vault created for a bot? | #30 Vault step: create, #29 One bot, one vault on HyperEVM |  |
| pos-39 | How do I fund a bot vault? | #31 Vault step: fund with USDC |  |
| pos-40 | Where does the bot execute its trades from the vault? | #32 Vault step: execute on Hyperliquid, #24 Hyperliquid: perps, spot, HyperEVM |  |
| pos-41 | How are vault deposits and withdrawals reconciled? | #33 Vault step: reconcile |  |
| pos-42 | Is there an iOS app? | #34 uLiquid Desk for iOS in development |  |
| pos-43 | When will the mobile app be available in the App Store? | #34 uLiquid Desk for iOS in development |  |
| pos-44 | Is there a free plan? | #35 Simple plans: start free, USDC, monthly, #36 Free plan, #41 One workspace, clear control |  |
| pos-45 | In which currency are subscriptions billed? | #35 Simple plans: start free, USDC, monthly, #37 Pro plan 29 USDC, #38 Premium plan 69 USDC |  |
| pos-46 | What is included in the Free plan? | #36 Free plan |  |
| pos-47 | How much does the Pro plan cost per month? | #37 Pro plan 29 USDC |  |
| pos-48 | How many AI credits are included in Pro? | #37 Pro plan 29 USDC |  |
| pos-49 | How much does Premium cost and how many bots does it allow? | #38 Premium plan 69 USDC |  |
| pos-50 | Which plan includes the Prediction Copier? | #38 Premium plan 69 USDC |  |
| pos-51 | Is the ULIQ token required to use the Desk? | #39 ULIQ optional utility token |  |
| pos-52 | What will locking ULIQ unlock? | #39 ULIQ optional utility token, #40 Round 1 window 19 Sep–31 Dec 2026 |  |
| pos-53 | When does presale Round 1 start and end? | #40 Round 1 window 19 Sep–31 Dec 2026, #2 Hero: AI market intelligence and controlled trading, Round 1 presale banner |  |
| pos-54 | Is AI-generated analysis financial advice? | #42 Risk disclosure, not financial advice |  |
| neg-lang-01 | Bekommt jeder Bot einen eigenen Vault? | — | German query: the corpus is English only; these chunks must not be returned: #0 Bot Vaults feature card, #29 One bot, one vault on HyperEVM |
| neg-lang-02 | Wie viel kostet der Pro-Plan? | — | German query: the corpus is English only; these chunks must not be returned: #37 Pro plan 29 USDC |
| neg-lang-03 | Welche Börsen werden unterstützt? | — | German query: the corpus is English only; these chunks must not be returned: #23 Your exchanges, one desk |
| neg-lang-04 | Kann die KI selbstständig Trades ausführen? | — | German query: the corpus is English only; these chunks must not be returned: #8 From noise to insight: AI never places a trade, 16 read-only skills |
| neg-lang-05 | Gibt es eine iOS-App? | — | German query: the corpus is English only; these chunks must not be returned: #34 uLiquid Desk for iOS in development |
| neg-lang-06 | Ist der ULIQ-Token für den Desk erforderlich? | — | German query: the corpus is English only; these chunks must not be returned: #39 ULIQ optional utility token |
| neg-lang-07 | Welche Benachrichtigungskanäle gibt es? | — | German query: the corpus is English only; these chunks must not be returned: #14 Notifications: in-app, Telegram, webhook |
| neg-lang-08 | Wann läuft die Presale-Runde 1? | — | German query: the corpus is English only; these chunks must not be returned: #40 Round 1 window 19 Sep–31 Dec 2026 |
| neg-time-01 | Does each trading bot get its own on-chain vault? | — | Asked as of 2026-10-01, before the current website version became valid (2026-10-05): these chunks must not be returned: #0 Bot Vaults feature card, #29 One bot, one vault on HyperEVM |
| neg-time-02 | How much does the Pro plan cost per month? | — | Asked as of 2026-10-01, before the current website version became valid (2026-10-05): these chunks must not be returned: #37 Pro plan 29 USDC |
| neg-time-03 | Which exchanges does uLiquid connect to? | — | Asked as of 2026-10-01, before the current website version became valid (2026-10-05): these chunks must not be returned: #23 Your exchanges, one desk |
| neg-time-04 | Is there an iOS app? | — | Asked as of 2026-10-01, before the current website version became valid (2026-10-05): these chunks must not be returned: #34 uLiquid Desk for iOS in development |
| neg-time-05 | What is included in the Free plan? | — | Asked as of 2026-10-01, before the current website version became valid (2026-10-05): these chunks must not be returned: #36 Free plan |
| neg-time-06 | When does presale Round 1 start and end? | — | Asked as of 2026-10-01, before the current website version became valid (2026-10-05): these chunks must not be returned: #40 Round 1 window 19 Sep–31 Dec 2026 |

## Chunk list (document version 2)

| # | Chunk ID | Content |
| --- | --- | --- |
| 0 | `c475ecce-25f6-467f-b9b9-267b5e68453d` | Bot Vaults feature card |
| 1 | `895518fe-96d0-4473-9140-a9a1a7f0bd5b` | Invalidation and risk rules (illustrative builder) |
| 2 | `ea8a8f8c-4b04-4654-b9c0-49db4a7937ad` | Hero: AI market intelligence and controlled trading, Round 1 presale banner |
| 3 | `41ee0b93-57d5-408c-98fa-1bf61c41cf02` | Dashboard & Portfolio |
| 4 | `c73ab462-d433-4b71-a8ef-3462a0b4361f` | Market Intelligence |
| 5 | `6b2a3b0e-07db-40bf-bd6c-dd6e9c6de2f0` | Trading Desk |
| 6 | `290434d6-8573-452c-a6cd-00db1d8d6c29` | AI Workbench |
| 7 | `89a44c82-a2c7-44c4-a05a-03d3be168b53` | Automation & Bots |
| 8 | `3beb1b92-c4e1-47d0-8463-969dd9445bb7` | From noise to insight: AI never places a trade, 16 read-only skills |
| 9 | `b21640c3-b18a-484c-b414-758f4cd75031` | AI Predictions |
| 10 | `eed01ae3-33ac-4270-8c47-74f9b062fab9` | Market Analyst |
| 11 | `99529fa8-393e-417d-95b0-491f6751eb47` | Position Copilot (read-only) |
| 12 | `1e8b6f3b-6a8e-46b1-8e07-5e3a719bab6d` | Trading: orders you review and approve |
| 13 | `1b15b5fd-f9cb-49bd-a88d-d8277cff95b8` | Bots: strategies checked against risk rules |
| 14 | `fa72ca67-5eb1-484f-92f4-a23a4a124a84` | Notifications: in-app, Telegram, webhook |
| 15 | `d15b3fb8-5cd9-4cf5-82a6-4891fe896b80` | Turn an idea into a structured market workflow |
| 16 | `65f5d3f6-ae98-40af-9109-b90db8aa0817` | BTC trend continuation example, reviewable workflow |
| 17 | `1c19a9b7-ed5d-4b2c-a3c4-331e914a774f` | Ready for review: nothing executes without approval |
| 18 | `03aaa0c7-f3e0-4a17-b1a5-3a3a540727ce` | Timeframe 4H |
| 19 | `af4aab28-f8ab-44f1-8b68-eb1ed269719f` | Entry conditions: price above 200 EMA, RSI above 55 |
| 20 | `ab1fdf2f-28df-41d4-9f8e-3e74df795770` | Invalidation: close below key support |
| 21 | `610c6d61-9326-4a11-b446-e0c9cbadaf76` | Risk rules: 1.0% per idea, max 3 positions |
| 22 | `6cbb6e62-a37f-4e32-bf2c-a79fe47e35c8` | Review, edit, discard |
| 23 | `15cd707b-bf70-4e16-ba69-66edc3c76ab0` | Your exchanges, one desk |
| 24 | `5c4cc497-9a46-43b5-a347-de5b969c038c` | Hyperliquid: perps, spot, HyperEVM |
| 25 | `6a2d28d3-2a22-4cf0-a701-bd41aefa9e63` | Binance: spot, USD-M futures |
| 26 | `0d9af6a7-fbc3-4a55-a785-46df7a137338` | Bitget: spot, perpetuals |
| 27 | `7e6fb69e-65be-49c5-a4b0-ace54aff335a` | MEXC: spot, perpetuals |
| 28 | `7b8c3085-f1d1-4995-8981-93cb6ac11d7f` | BingX, planned exchanges, paper trading simulation |
| 29 | `2513bfc7-8549-4bff-85d3-e9f19d04802c` | One bot, one vault on HyperEVM |
| 30 | `472cad1b-13f8-4922-89ed-65a40480b5fe` | Vault step: create |
| 31 | `add2f120-4b98-4b74-9fea-0dd4c14708ee` | Vault step: fund with USDC |
| 32 | `b358eafb-f726-488b-9d3c-140f0e469423` | Vault step: execute on Hyperliquid |
| 33 | `126b786c-5894-416d-80fe-97e0a7aa27f4` | Vault step: reconcile |
| 34 | `b080502a-d51c-4d47-8569-204c22226d15` | uLiquid Desk for iOS in development |
| 35 | `c1d634c5-955d-43ac-8b51-2e37c5f17bda` | Simple plans: start free, USDC, monthly |
| 36 | `d53e1f8f-b08f-4026-a38d-c260e2be4c79` | Free plan |
| 37 | `72826f1d-60b4-4c08-b233-84f54fa44b6f` | Pro plan 29 USDC |
| 38 | `c90fe9c9-5975-4891-b6b9-48afc6c1b4cb` | Premium plan 69 USDC |
| 39 | `4aa4d7f8-ea8a-419c-9ead-3b847640b755` | ULIQ optional utility token |
| 40 | `f81470a7-18ac-4a3b-8990-9d0d093ea5f7` | Round 1 window 19 Sep–31 Dec 2026 |
| 41 | `611b1f97-bef0-491f-a456-dce338028cc8` | One workspace, clear control |
| 42 | `1cdc501c-cab2-4c39-b934-15bcd29047c8` | Risk disclosure, not financial advice |
| 43 | `59723ab6-26eb-4a23-815c-9b0bf2fc6664` | Matomo analytics consent |
