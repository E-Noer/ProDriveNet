import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';

const app = express();

/* Allow local dev tools; production is same-origin and won’t hit CORS */
const allowed = new Set([
  'http://127.0.0.1:3001','http://localhost:3001',
  'http://127.0.0.1:5500','http://localhost:5500',
  'http://127.0.0.1:15500','http://localhost:15500',
  'https://prodrivenet.com','https://www.prodrivenet.com'
]);
app.use(cors({
  origin: (origin, cb) => (!origin ? cb(null, true) : cb(null, allowed.has(origin)))
}));
app.use(express.json({ limit: '12mb' }));

/* Serve your static site (index.html, platform.html, etc.) */
const __dirname = path.resolve();
app.use(express.static(__dirname, { extensions: ['html'], cacheControl: false }));

const RDW_HOST = 'https://opendata.rdw.nl';
const RDW = {
  basis:  '/resource/m9d7-ebf2.json',
  brand:  '/resource/8ys7-d773.json',
  kleuren:'/resource/ihha-7xnj.json',
  carr:   '/resource/vezc-m2t6.json',
  carrs:  '/resource/jhie-znh9.json',
  assen:  '/resource/3huj-srit.json'
};

const parseDate = (s) => (s && s.length === 8) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null;

app.get('/api/rdw', async (req, res) => {
  const plate = String(req.query.kenteken || '').toUpperCase().replace(/-/g,'');
  if (!/^[A-Z0-9]{1,8}$/.test(plate)) return res.status(400).json({ error: 'Ongeldig kentekenformaat' });

  // Send ONLY X-App-Token. Socrata rejects unexpected auth headers.
  const headers = {};
  if (process.env.RDW_APP_TOKEN) headers['X-App-Token'] = process.env.RDW_APP_TOKEN;

  // Helper to fetch + echo debug on failures
  const q = async (path) => {
    const url = `${RDW_HOST}${path}?kenteken=${encodeURIComponent(plate)}`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (!r.ok) {
      console.error('[RDW FAIL]', r.status, r.statusText, url, 'BODY:', text.slice(0,400));
      throw new Error(text || `RDW ${r.status} ${r.statusText}`);
    }
    try { return JSON.parse(text); } catch (e) {
      console.error('[RDW PARSE ERROR]', url, text.slice(0,400));
      throw new Error('Kon RDW-antwoord niet parsen');
    }
  };

  try {
    const [basisArr, brandstofArr, kleurArr, carrArr, carrSpecArr, asArr] = await Promise.all([
      q(RDW.basis), q(RDW.brand), q(RDW.kleuren), q(RDW.carr), q(RDW.carrs), q(RDW.assen)
    ]);

    const b = basisArr?.[0] || {};
    if (!b.merk && !b.handelsbenaming) return res.status(404).json({ error: 'Geen voertuig gevonden voor kenteken.' });

    const fuels = (brandstofArr||[]).map(x => ({
      volgnummer: x.brandstof_volgnummer ? Number(x.brandstof_volgnummer) : null,
      omschrijving: x.brandstof_omschrijving || null,
      verbruik_buiten_l_per_100km: x.brandstofverbruik_buiten ? Number(x.brandstofverbruik_buiten) : null,
      verbruik_gecombineerd_l_per_100km: x.brandstofverbruik_gecombineerd ? Number(x.brandstofverbruik_gecombineerd) : null,
      verbruik_stad_l_per_100km: x.brandstofverbruik_stad ? Number(x.brandstofverbruik_stad) : null,
      co2_gecombineerd_g_km: x.co2_uitstoot_gecombineerd ? Number(x.co2_uitstoot_gecombineerd) : null,
      emissiecode_omschrijving: x.emissiecode_omschrijving || null,
      uitlaatemissieniveau: x.uitlaatemissieniveau || null,
      nettomaximumvermogen_kw: x.nettomaximumvermogen ? Number(x.nettomaximumvermogen) : null,
      geluidsniveau_rijdend_db: x.geluidsniveau_rijdend ? Number(x.geluidsniveau_rijdend) : null,
      geluidsniveau_stationair_db: x.geluidsniveau_stationair ? Number(x.geluidsniveau_stationair) : null,
      toerental_geluidsniveau: x.toerental_geluidsniveau ? Number(x.toerental_geluidsniveau) : null
    })).sort((a,b)=> (a.volgnummer||0)-(b.volgnummer||0));

    const kleuren = (kleurArr||[]).map(k => ({ eerste_kleur:k.eerste_kleur||null, tweede_kleur:k.tweede_kleur||null }));
    const carr   = (carrArr||[]).map(c => ({ carrosserie_volgnummer:c.carrosserie_volgnummer?+c.carrosserie_volgnummer:null, carrosserietype_omschrijving:c.carrosserietype_omschrijving||null }));
    const carrS  = (carrSpecArr||[]).map(c => ({ carrosserie_volgnummer:c.carrosserie_volgnummer?+c.carrosserie_volgnummer:null, carrosserietype_omschrijving:c.carrosserietype_omschrijving||null }));
    const assen  = (asArr||[]).map(a => ({
      asnummer: a.asnummer?+a.asnummer:null,
      spoorbreedte: a.spoorbreedte?+a.spoorbreedte:null,
      technische_max_aslast: a.technische_max_aslast?+a.technische_max_aslast:null,
      wielbasis: a.wielbasis?+a.wielbasis:null,
      aantal_assen: a.aantal_assen?+a.aantal_assen:null,
      aslast_technisch_toegestaan: a.aslast_technisch_toegestaan?+a.aslast_technisch_toegestaan:null
    }));

    const summary = {
      kenteken: plate,
      merk: b.merk || null,
      handelsbenaming: b.handelsbenaming || null,
      voertuigsoort: b.voertuigsoort || null,
      bouwjaar: b.datum_eerste_toelating ? Number(b.datum_eerste_toelating.slice(0,4)) : null,
      datum_eerste_toelating: parseDate(b.datum_eerste_toelating),
      apk_vervaldatum: parseDate(b.vervaldatum_apk),
      kleur: (kleuren[0]?.eerste_kleur || b.eerste_kleur || null),
      tweede_kleur: (kleuren[0]?.tweede_kleur || null),
      brandstof: fuels[0]?.omschrijving || null,
      zitplaatsen: b.aantal_zitplaatsen ? +b.aantal_zitplaatsen : null,
      deuren: b.aantal_deuren ? +b.aantal_deuren : null,
      massa_rijklaar_kg: b.massa_rijklaar ? +b.massa_rijklaar : null
    };

    const details = {
      basis: {
        voertuigsoort: b.voertuigsoort || null,
        merk: b.merk || null,
        handelsbenaming: b.handelsbenaming || null,
        inrichting: b.inrichting || null,
        catalogusprijs: b.catalogusprijs ? +b.catalogusprijs : null,
        aantal_cilinders: b.aantal_cilinders ? +b.aantal_cilinders : null,
        cilinderinhoud_cc: b.cilinderinhoud ? +b.cilinderinhoud : null,
        lengte_cm: b.lengte ? +b.lengte : null,
        breedte_cm: b.breedte ? +b.breedte : null,
        hoogte_cm: b.hoogte_voertuig ? +b.hoogte_voertuig : null,
        wielbasis_cm: b.wielbasis ? +b.wielbasis : null,
        eu_voertuigcategorie: b.europese_voertuigcategorie || null,
        zuinigheidsclassificatie: b.zuinigheidsclassificatie || null,
        type: b.type || null,
        variant: b.variant || null,
        uitvoering: b.uitvoering || null,
        typegoedkeuringsnummer: b.typegoedkeuringsnummer || null,
        datum_eerste_toelating: parseDate(b.datum_eerste_toelating),
        datum_tenaamstelling: parseDate(b.datum_tenaamstelling),
        datum_eerste_tenaamstelling_in_nederland: parseDate(b.datum_eerste_tenaamstelling_in_nederland),
        apk_vervaldatum: parseDate(b.vervaldatum_apk),
        wam_verzekerd: b.wam_verzekerd || null,
        export_indicator: b.export_indicator || null,
        openstaande_terugroepactie_indicator: b.openstaande_terugroepactie_indicator || null,
        taxi_indicator: b.taxi_indicator || null,
        tellerstandoordeel: b.tellerstandoordeel || null
      },
      brandstoffen: fuels,
      kleuren,
      carrosserie: carr,
      carrosserie_specifiek: carrS,
      assen
    };

    res.json({ summary, details });
  } catch (e) {
    console.error('[RDW ERROR]', e);
    res.status(502).json({ error: 'RDW service fout', detail: String(e?.message || e) });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT} — proxy /api from Nginx`));