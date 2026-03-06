# IMOSCAN API

Le vendeur promet. IMOSCAN prouve.

## Endpoint

`POST /api/analyze`

### Body

```json
{
  "normalizedText": "Texte de l'annonce immobilière...",
  "mode": "COMPACT"
}
```

### Response

JSON V3.2 avec verdict, lecture narrative, scores, munitions, offre.

## Deploy

```bash
npm install
npm run dev
```

Environment variable required: `ANTHROPIC_API_KEY`
