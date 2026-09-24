# NestJS + React Full Stack Starter

A full-stack starter: a **NestJS** API that also hosts a compiled **React** (Vite + Tailwind) client — single-service deployment.

*Release: 2026.09*

## Stack

| Layer    | Tech                                      |
| -------- | ----------------------------------------- |
| Server   | NestJS 12 + TypeScript (Express 5)        |
| Client   | React 19 + Vite 8 + TypeScript            |
| Styling  | Tailwind CSS 4                            |
| Routing  | React Router 8                            |
| HTTP     | Axios 1                                   |
| Monorepo | npm workspaces (`server/`, `client/`)     |

## Requirements

- Node.js `^22.22` or `>=24.15` (tested on v24)

## Getting started

```bash
npm install       # installs all workspaces
npm run dev       # starts NestJS (:3000) + Vite (:5173) together
```

- Client: http://localhost:5173
- API:    http://localhost:3000/api/version
- Vite proxies `/api/*` to the NestJS server, so the client hits the local API with no config.

## Production

```bash
npm run build              # build client, then server
npm run start              # node server/dist/main.js  -> http://localhost:3000
# or in one step:
npm run start:prod
```

In production the NestJS server serves the compiled React app from `client/dist` and exposes the API under `/api`. SPA deep links (e.g. a refresh on `/about`) fall back to `index.html`.

## Scripts

| Command             | Description                                      |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Run server (watch) + client concurrently         |
| `npm run build`     | Build client then server                         |
| `npm run start`     | Run the compiled server                          |
| `npm run start:prod`| Build + start in one command                     |

## Project structure

```
node-react/
├─ package.json            # workspace root + scripts
├─ server/                 # NestJS API + static host
│  └─ src/
│     ├─ main.ts           # bootstrap, /api prefix, static + SPA fallback
│     ├─ app.module.ts
│     └─ version/          # GET /api/version
└─ client/                 # React (Vite) app
   └─ src/
      ├─ App.tsx           # routes
      ├─ components/Layout.tsx
      ├─ pages/{Welcome,About,NotFound}.tsx
      └─ lib/api.ts        # axios instance + fetchVersion()
```

## API

| Method | Path            | Response                                             |
| ------ | --------------- | ---------------------------------------------------- |
| GET    | `/api/version`  | `{ name, version, node, timestamp }`                 |

## Pages

- `/` — welcome page
- `/about` — calls `GET /api/version` and shows the live API version, plus the UI build version

---

NestJS + React Full Stack Starter · 2026.09
