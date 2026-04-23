# 🏦 Caja ORUM — Sistema de Arqueo

App Node.js/Express para gestión de caja diaria de ORUM Rent & Events.
Conecta con la API de Rentman para leer pagos registrados con métodos:
- **Efectivo Marbella** / **Efectivo Monda**
- **TPV Marbella** / **TPV Monda**

## Funcionalidades

- Carga cobros del día desde Rentman
- Caja separada por ubicación (Marbella / Monda)
- Saldo inicial configurable
- Retiradas de efectivo con concepto
- Documento de cierre imprimible (Marbella, Monda, o Global)

## Deploy en Railway

1. Sube este proyecto a un repositorio GitHub
2. En Railway → New Project → Deploy from GitHub repo
3. Selecciona el repo → Railway detecta automáticamente Node.js
4. La app arranca en el puerto asignado por Railway

## Uso

1. Abre la app en el navegador
2. Click en ⚙ Configurar → introduce tu JWT de Rentman
3. Selecciona la fecha y click "Cargar cobros"
4. Ajusta saldo inicial y añade retiradas si las hay
5. Click en "Cierre Marbella" / "Cierre Monda" / "Cierre Global" para generar el documento
6. Imprime o guarda como PDF

## Estructura

```
caja-orum/
├── server.js          # Backend Express + proxy Rentman
├── package.json
├── railway.json
└── public/
    └── index.html     # Frontend completo
```

## Endpoints API

- `GET /api/pagos?token=...&fecha=YYYY-MM-DD` — Cobros del día
- `GET /api/pagos/rango?token=...&desde=...&hasta=...` — Rango de fechas
- `POST /api/caja/cierre` — Calcula cierre
