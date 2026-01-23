# Ordenate Backend - Billing Endpoints Fix

## Resumen

Este documento contiene las instrucciones para corregir los endpoints de costos en `server.js`. Hay 2 endpoints que necesitan ser reemplazados completamente.

---

## 1. Variables de Entorno Requeridas

Agregar en Railway → Variables:

```env
ANTHROPIC_ADMIN_API_KEY=sk-ant-admin-xxx        # Ya debería existir
ANTHROPIC_ORDENATE_API_KEY_ID=apikey_01C2U3UNXic3Fuy6JZA7B6xk
RAILWAY_API_TOKEN=xxx                            # Ya debería existir
RAILWAY_PROJECT_ID=678ac9d6-1352-4e11-96bd-dbfdf3a69e49
```

---

## 2. Reemplazar Endpoint: `/api/admin/costs/anthropic`

**Ubicación:** Aproximadamente líneas 4142-4229

**Problema actual:** 
- Filtra por `description.includes('haiku')` pero el modelo viene en campo `model`
- No filtra por API key específica de Ordenate
- Muestra costos de todas las API keys (incluyendo uso personal)

**Reemplazar TODO el endpoint con este código:**

```javascript
// GET /api/admin/costs/anthropic - Uso de Claude API (filtrado por API key de Ordenate)
app.get('/api/admin/costs/anthropic', authenticateAdmin, async (req, res) => {
  try {
    const { startDate, endDate, period } = req.query;

    const now = new Date();
    let start, end;

    // Soporte para períodos predefinidos
    if (period) {
      switch (period) {
        case 'today':
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          end = now;
          break;
        case 'yesterday':
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
          end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'last7days':
          start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          end = now;
          break;
        case 'last30days':
          start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          end = now;
          break;
        case 'thisMonth':
          start = new Date(now.getFullYear(), now.getMonth(), 1);
          end = now;
          break;
        case 'lastMonth':
          start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          end = new Date(now.getFullYear(), now.getMonth(), 0);
          break;
        default:
          start = new Date(now.getFullYear(), now.getMonth(), 1);
          end = now;
      }
    } else {
      // Fechas personalizadas o default (mes actual hasta hoy)
      start = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
      end = endDate ? new Date(endDate) : now;
    }

    // Validar que start < end
    if (start > end) {
      return res.status(400).json({ error: 'startDate must be before endDate' });
    }

    // Limitar rango máximo a 90 días
    const maxRangeDays = 90;
    const rangeDays = (end - start) / (1000 * 60 * 60 * 24);
    if (rangeDays > maxRangeDays) {
      return res.status(400).json({ 
        error: `Date range too large. Maximum is ${maxRangeDays} days.`,
        requestedDays: Math.round(rangeDays)
      });
    }

    const adminApiKey = process.env.ANTHROPIC_ADMIN_API_KEY;
    const ordenateApiKeyId = process.env.ANTHROPIC_ORDENATE_API_KEY_ID || 'apikey_01C2U3UNXic3Fuy6JZA7B6xk';
    
    if (!adminApiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_ADMIN_API_KEY not configured' });
    }

    // Determinar bucket_width según el rango de fechas
    let bucketWidth = '1d';
    if (rangeDays <= 2) {
      bucketWidth = '1h';
    }

    // IMPORTANTE: Usar api_key_ids[] para filtrar solo ordenate-prod
    const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    url.searchParams.append('starting_at', start.toISOString());
    url.searchParams.append('ending_at', end.toISOString());
    url.searchParams.append('bucket_width', bucketWidth);
    url.searchParams.append('group_by[]', 'api_key_id');
    url.searchParams.append('group_by[]', 'description');
    url.searchParams.append('api_key_ids[]', ordenateApiKeyId);

    const response = await axios.get(url.toString(), {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': adminApiKey
      }
    });

    const buckets = response.data?.data || [];
    
    let totalCost = 0;
    let inputCost = 0;
    let outputCost = 0;
    const dailyCosts = [];

    buckets.forEach(bucket => {
      const results = bucket.results || [];
      let dayTotal = 0;
      let dayInput = 0;
      let dayOutput = 0;

      results.forEach(result => {
        // El amount está en centavos, convertir a USD
        const amountUSD = parseFloat(result.amount || 0) / 100;
        const tokenType = result.token_type || '';
        
        dayTotal += amountUSD;
        totalCost += amountUSD;

        if (tokenType.includes('input')) {
          inputCost += amountUSD;
          dayInput += amountUSD;
        } else if (tokenType === 'output_tokens') {
          outputCost += amountUSD;
          dayOutput += amountUSD;
        }
      });

      if (dayTotal > 0) {
        dailyCosts.push({
          date: bucket.starting_at?.split('T')[0],
          cost: Math.round(dayTotal * 100) / 100,
          input: Math.round(dayInput * 100) / 100,
          output: Math.round(dayOutput * 100) / 100
        });
      }
    });

    // Paginación si hay más datos
    const hasMore = response.data?.has_more || false;
    const nextPage = response.data?.next_page || null;

    res.json({
      period: { 
        start: start.toISOString().split('T')[0], 
        end: end.toISOString().split('T')[0],
        days: Math.round(rangeDays),
        bucketWidth
      },
      summary: {
        totalCost: Math.round(totalCost * 100) / 100,
        inputCost: Math.round(inputCost * 100) / 100,
        outputCost: Math.round(outputCost * 100) / 100,
        model: 'claude-haiku-4.5',
        currency: 'USD',
        apiKeyName: 'ordenate-prod'
      },
      dailyCosts,
      pagination: {
        hasMore,
        nextPage,
        bucketsReturned: buckets.length
      }
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Anthropic costs error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error fetching Anthropic costs', details: error.response?.data });
  }
});
```

---

## 3. Reemplazar Endpoint: `/api/admin/costs/railway`

**Ubicación:** Aproximadamente líneas 4273-4332

**Problema actual:**
- Solo obtiene nombres de servicios
- No calcula costos basados en métricas de uso
- Dice "Railway no expone costos por API" (incorrecto)

**Reemplazar TODO el endpoint con este código:**

```javascript
// GET /api/admin/costs/railway - Uso y costos calculados de Railway
app.get('/api/admin/costs/railway', authenticateAdmin, async (req, res) => {
  try {
    const railwayToken = process.env.RAILWAY_API_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID || '678ac9d6-1352-4e11-96bd-dbfdf3a69e49';

    if (!railwayToken) {
      return res.status(500).json({ error: 'RAILWAY_API_TOKEN not configured' });
    }

    // 1. Query para obtener métricas de uso
    const usageQuery = `
      query {
        usage(
          measurements: [CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB],
          groupBy: [SERVICE_ID],
          projectId: "${projectId}"
        ) {
          measurement
          value
          tags {
            serviceId
          }
        }
      }
    `;

    // 2. Query para obtener nombres de servicios
    const projectQuery = `
      query {
        project(id: "${projectId}") {
          name
          services {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const [usageResponse, projectResponse] = await Promise.all([
      axios.post('https://backboard.railway.com/graphql/v2',
        { query: usageQuery },
        {
          headers: {
            'Authorization': `Bearer ${railwayToken}`,
            'Content-Type': 'application/json'
          }
        }
      ),
      axios.post('https://backboard.railway.com/graphql/v2',
        { query: projectQuery },
        {
          headers: {
            'Authorization': `Bearer ${railwayToken}`,
            'Content-Type': 'application/json'
          }
        }
      )
    ]);

    // Verificar errores GraphQL
    if (usageResponse.data.errors) {
      console.error('⚠️ Railway usage errors:', usageResponse.data.errors);
      return res.status(500).json({ 
        error: 'Railway API error', 
        details: usageResponse.data.errors[0]?.message 
      });
    }

    const usageData = usageResponse.data.data?.usage || [];
    const project = projectResponse.data.data?.project;
    
    // Crear mapa de serviceId -> nombre
    const serviceNames = {};
    project?.services?.edges?.forEach(edge => {
      serviceNames[edge.node.id] = edge.node.name;
    });

    // Precios Railway (por minuto) - https://railway.app/pricing
    const RAILWAY_PRICES = {
      CPU_PER_VCPU_MINUTE: 0.000463,
      MEMORY_PER_GB_MINUTE: 0.000231,
      NETWORK_PER_GB: 0.10
    };

    // Agrupar métricas por servicio
    const serviceMetrics = {};
    usageData.forEach(item => {
      const serviceId = item.tags?.serviceId;
      if (!serviceId) return;
      
      if (!serviceMetrics[serviceId]) {
        serviceMetrics[serviceId] = {
          name: serviceNames[serviceId] || serviceId.substring(0, 8),
          cpu: 0,
          memory: 0,
          network: 0
        };
      }
      
      if (item.measurement === 'CPU_USAGE') {
        serviceMetrics[serviceId].cpu += item.value || 0;
      } else if (item.measurement === 'MEMORY_USAGE_GB') {
        serviceMetrics[serviceId].memory += item.value || 0;
      } else if (item.measurement === 'NETWORK_TX_GB') {
        serviceMetrics[serviceId].network += item.value || 0;
      }
    });

    // Calcular costos por servicio
    let totalCost = 0;
    const services = Object.entries(serviceMetrics).map(([id, metrics]) => {
      const cpuCost = metrics.cpu * RAILWAY_PRICES.CPU_PER_VCPU_MINUTE;
      const memoryCost = metrics.memory * RAILWAY_PRICES.MEMORY_PER_GB_MINUTE;
      const networkCost = metrics.network * RAILWAY_PRICES.NETWORK_PER_GB;
      const serviceCost = cpuCost + memoryCost + networkCost;
      totalCost += serviceCost;

      return {
        id,
        name: metrics.name,
        usage: {
          cpu: Math.round(metrics.cpu * 100) / 100,
          memoryGB: Math.round(metrics.memory * 100) / 100,
          networkGB: Math.round(metrics.network * 1000000) / 1000000
        },
        costs: {
          cpu: Math.round(cpuCost * 100) / 100,
          memory: Math.round(memoryCost * 100) / 100,
          network: Math.round(networkCost * 100) / 100,
          total: Math.round(serviceCost * 100) / 100
        }
      };
    });

    res.json({
      project: project?.name || 'Unknown',
      summary: {
        totalCost: Math.round(totalCost * 100) / 100,
        currency: 'USD'
      },
      services,
      pricing: {
        cpu: '$0.000463/vCPU-min',
        memory: '$0.000231/GB-min',
        network: '$0.10/GB egress'
      },
      note: 'Costos calculados desde métricas de uso del ciclo de facturación actual.'
    });
  } catch (error) {
    console.error('⚠️ ADMIN: Railway costs error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Error fetching Railway data', 
      details: error.response?.data?.errors?.[0]?.message || error.message 
    });
  }
});
```

---

## 4. Ejemplos de Uso de los Endpoints

### Anthropic

```bash
# Mes actual (default)
GET /api/admin/costs/anthropic

# Períodos predefinidos
GET /api/admin/costs/anthropic?period=today
GET /api/admin/costs/anthropic?period=yesterday
GET /api/admin/costs/anthropic?period=last7days
GET /api/admin/costs/anthropic?period=last30days
GET /api/admin/costs/anthropic?period=thisMonth
GET /api/admin/costs/anthropic?period=lastMonth

# Rango personalizado
GET /api/admin/costs/anthropic?startDate=2026-01-01&endDate=2026-01-15
```

### Railway

```bash
# Uso actual del ciclo de facturación
GET /api/admin/costs/railway
```

---

## 5. Respuestas Esperadas

### Anthropic (debería mostrar ~$0.47)

```json
{
  "period": {
    "start": "2026-01-01",
    "end": "2026-01-23",
    "days": 22,
    "bucketWidth": "1d"
  },
  "summary": {
    "totalCost": 0.47,
    "inputCost": 0.35,
    "outputCost": 0.12,
    "model": "claude-haiku-4.5",
    "currency": "USD",
    "apiKeyName": "ordenate-prod"
  },
  "dailyCosts": [
    { "date": "2026-01-07", "cost": 0.04, "input": 0.03, "output": 0.01 },
    { "date": "2026-01-15", "cost": 0.12, "input": 0.09, "output": 0.03 }
  ],
  "pagination": {
    "hasMore": false,
    "nextPage": null,
    "bucketsReturned": 22
  }
}
```

### Railway (debería mostrar ~$0.51)

```json
{
  "project": "ordenate-backend",
  "summary": {
    "totalCost": 0.51,
    "currency": "USD"
  },
  "services": [
    {
      "id": "21f7b604-a65c-477f-bc71-422ba2a30ec9",
      "name": "Postgres",
      "usage": { "cpu": 0.43, "memoryGB": 1289.46, "networkGB": 0.0037 },
      "costs": { "cpu": 0.0002, "memory": 0.30, "network": 0.0004, "total": 0.30 }
    },
    {
      "id": "26418e8a-96d9-4fc2-98a7-056c38ccb94b",
      "name": "ordenate-backend",
      "usage": { "cpu": 6.70, "memoryGB": 784.18, "networkGB": 0.0095 },
      "costs": { "cpu": 0.003, "memory": 0.18, "network": 0.001, "total": 0.18 }
    }
  ],
  "pricing": {
    "cpu": "$0.000463/vCPU-min",
    "memory": "$0.000231/GB-min",
    "network": "$0.10/GB egress"
  }
}
```

---

## 6. Checklist de Implementación

- [ ] Agregar variable `ANTHROPIC_ORDENATE_API_KEY_ID` en Railway
- [ ] Verificar que `RAILWAY_PROJECT_ID` existe en Railway
- [ ] Reemplazar endpoint `/api/admin/costs/anthropic` (líneas ~4142-4229)
- [ ] Reemplazar endpoint `/api/admin/costs/railway` (líneas ~4273-4332)
- [ ] Hacer deploy
- [ ] Probar endpoints y verificar que los costos coincidan con los dashboards oficiales
