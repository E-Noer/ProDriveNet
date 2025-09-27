import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';

const app = express();

// --- Static (optional) ---
app.use(express.static(process.cwd(), { extensions: ['html'] }));

// Serve client-side env
app.get('/env.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-store');

  const url  = process.env.SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || '';

  // Only anon key is sent to browser
  res.end(
    `window.__SUPABASE_URL__=${JSON.stringify(url)};
     window.__SUPABASE_ANON_KEY__=${JSON.stringify(anon)};`
  );
});

// --- CORS for local dev; prod is same-origin ---
const allowed = new Set([
  'http://127.0.0.1:3001','http://localhost:3001',
  'http://127.0.0.1:5500','http://localhost:5500',
  'https://prodrivenet.com','https://www.prodrivenet.com',
  'https://e-noer.nl','https://www.e-noer.nl'
]);
app.use(cors({
  origin: (origin, cb) => (!origin ? cb(null, true) : cb(null, allowed.has(origin))),
  credentials: true
}));

// ---------- RDW ----------
const RDW_HOST = 'https://opendata.rdw.nl';
const RDW = {
  basis:  '/resource/m9d7-ebf2.json',     // Voertuigen basis (kenteken)
  brand:  '/resource/8ys7-d773.json',     // Brandstof per kenteken
  kleuren:'/resource/ihha-7xnj.json',     // Kleuren per kenteken
  assen:  '/resource/3huj-srit.json'      // Assen per kenteken
  // NOTE: many "carrosserie" datasets are NOT keyed by kenteken; skip to avoid 400s
};

const parseDate = (s) => (s && s.length === 8) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null;

app.get('/api/rdw', async (req, res) => {
  const plate = String(req.query.kenteken || '').toUpperCase().replace(/-/g,'').trim();
  if (!/^[A-Z0-9]{1,8}$/.test(plate)) return res.status(400).json({ error: 'Ongeldig kentekenformaat' });

  const headers = {};
  if (process.env.RDW_APP_TOKEN) headers['X-App-Token'] = process.env.RDW_APP_TOKEN;

  const fetchJSON = async (path) => {
    const url = `${RDW_HOST}${path}?kenteken=${encodeURIComponent(plate)}`;
    const r = await fetch(url, { headers });
    const body = await r.text();
    if (!r.ok) {
      console.error('[RDW FAIL]', r.status, r.statusText, url, 'BODY:', body.slice(0,400));
      throw new Error(body || `RDW ${r.status} ${r.statusText}`);
    }
    try { return JSON.parse(body); } catch (e) {
      console.error('[RDW PARSE]', url, body.slice(0,200));
      throw new Error('Kon RDW-antwoord niet parsen');
    }
  };

  // Fetch basis first, then others (independently). If one fails, continue.
  let basis = null, brand = [], kleuren = [], assen = [], warnings = [];
  try { const arr = await fetchJSON(RDW.basis); basis = arr?.[0] || null; }
  catch (e) { warnings.push(`basis: ${String(e.message).slice(0,140)}`); }

  if (!basis) return res.status(404).json({ error: 'Geen voertuig gevonden voor kenteken.' });

  await Promise.all([
    (async()=>{ try { brand = await fetchJSON(RDW.brand); } catch(e){ warnings.push(`brandstof: ${String(e.message).slice(0,140)}`); }})(),
    (async()=>{ try { kleuren = await fetchJSON(RDW.kleuren); } catch(e){ warnings.push(`kleuren: ${String(e.message).slice(0,140)}`); }})(),
    (async()=>{ try { assen = await fetchJSON(RDW.assen); } catch(e){ warnings.push(`assen: ${String(e.message).slice(0,140)}`); }})(),
  ]);

  const fuels = (brand||[]).map(x => ({
    brandstof_volgnummer: x.brandstof_volgnummer ? Number(x.brandstof_volgnummer) : null,
    omschrijving: x.brandstof_omschrijving || x.brandstof_omschrijving || null,
    co2_gecombineerd_g_km: x.co2_uitstoot_gecombineerd ? Number(x.co2_uitstoot_gecombineerd) : null,
    nettomaximumvermogen_kw: x.nettomaximumvermogen ? Number(x.nettomaximumvermogen) : null,
  })).sort((a,b)=>(a.brandstof_volgnummer||99)-(b.brandstof_volgnummer||99));

  const summary = {
    kenteken: plate,
    merk: basis.merk || null,
    handelsbenaming: basis.handelsbenaming || null,
    voertuigsoort: basis.voertuigsoort || null,
    bouwjaar: basis.datum_eerste_toelating ? Number(basis.datum_eerste_toelating.slice(0,4)) : null,
    datum_eerste_toelating: parseDate(basis.datum_eerste_toelating),
    apk_vervaldatum: parseDate(basis.vervaldatum_apk),
    kleur: (kleuren[0]?.eerste_kleur || basis.eerste_kleur || null),
    tweede_kleur: (kleuren[0]?.tweede_kleur || null),
    brandstof: fuels[0]?.omschrijving || null,
    zitplaatsen: basis.aantal_zitplaatsen ? Number(basis.aantal_zitplaatsen) : null,
    deuren: basis.aantal_deuren ? Number(basis.aantal_deuren) : null,
    massa_rijklaar_kg: basis.massa_rijklaar ? Number(basis.massa_rijklaar) : null
  };

  const details = {
    basis: {
      voertuigsoort: basis.voertuigsoort || null,
      merk: basis.merk || null,
      handelsbenaming: basis.handelsbenaming || null,
      inrichting: basis.inrichting || null,
      catalogusprijs: basis.catalogusprijs ? Number(basis.catalogusprijs) : null,
      aantal_cilinders: basis.aantal_cilinders ? Number(basis.aantal_cilinders) : null,
      cilinderinhoud_cc: basis.cilinderinhoud ? Number(basis.cilinderinhoud) : null,
      lengte_cm: basis.lengte ? Number(basis.lengte) : null,
      breedte_cm: basis.breedte ? Number(basis.breedte) : null,
      hoogte_cm: basis.hoogte ? Number(basis.hoogte) : null,
      wielbasis_cm: basis.wielbasis ? Number(basis.wielbasis) : null,
      eu_voertuigcategorie: basis.eu_voertuigcategorie || null,
      type: basis.type || null,
      variant: basis.variant || null,
      uitvoering: basis.uitvoering || null,
      wam_verzekerd: basis.wam_verzekerd || null,
      taxi_indicator: basis.taxi_indicator || null,
      openstaande_terugroepactie_indicator: basis.openstaande_terugroepactie_indicator || null
    },
    brandstoffen: fuels,
    kleuren: (kleuren||[]).map(k=>({ eerste_kleur:k.eerste_kleur||null, tweede_kleur:k.tweede_kleur||null })),
    assen: (assen||[]).map(a=>({
      asnummer: a.asnummer?Number(a.asnummer):null,
      spoorbreedte: a.spoorbreedte?Number(a.spoorbreedte):null,
      technische_max_aslast: a.technische_max_aslast?Number(a.technische_max_aslast):null,
      wielbasis: a.wielbasis?Number(a.wielbasis):null,
      aantal_assen: a.aantal_assen?Number(a.aantal_assen):null,
      aslast_technisch_toegestaan: a.aslast_technisch_toegestaan?Number(a.aslast_technisch_toegestaan):null
    })),
    warnings
  };

  res.json({ summary, details });
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, ()=> console.log(`✅ API listening on ${PORT}`));