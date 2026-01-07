# 💰 Ordenate Backend

Backend para app de finanzas personales vía WhatsApp.

## 🚀 Stack

- **Node.js + Express** - Servidor web
- **Twilio** - WhatsApp Business API
- **PostgreSQL (Railway)** - Base de datos
- **Anthropic Claude** - IA para categorización

## 📋 Features

- ✅ Registro de gastos/ingresos por WhatsApp
- ✅ Categorización automática con IA
- ✅ Consultas de gastos por período
- ✅ Presupuestos por categoría
- ✅ Alertas de presupuesto (Premium)

## 🔧 Variables de Entorno

Ver `.env.example` para template completo.

## 📦 Instalación Local

```bash
npm install
npm start
```

## 🌐 Deploy

Conectado a Railway para deploy automático desde GitHub.

## 📱 Uso

Enviar mensajes de WhatsApp al número de Twilio Sandbox:
- `gasté 5000 en almuerzo`
- `¿cuánto gasté esta semana?`
- `quiero gastar máximo 100000 en comida`

## 📄 Licencia

MIT - Javier Bassino @ Bassino Digital
