// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';

const app = express();

// --- Basic middleware
app.use(cors());
app.use(express.json({ limit: '12mb' }));

// --- Paths (ESM-friendly)
const __dirname = path.resolve();
const PUBLIC_DIR = path.join(__dirname);

// --- Expose safe env values for the browser (Supabase only)
app.get('/env.js', (req, res) => {
  const url  = process.env.SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || '';
  res.set('Cache-Control', 'no-store'); // ensure fresh values during dev
  res.type('application/javascript').send(
    `window.__SUPABASE_URL__=${JSON.stringify(url)};window.__SUPABASE_ANON_KEY__=${JSON.stringify(anon)};`
  );
});

// --- RDW Open Data proxy (uses App Token if provided)
//     Datasets:
//       - Basisgegevens voertuigen: m9d7-ebf2
//       - Brandstof:               8ys7-d773
//       - Kleur:                   ihha-7xnj
// --- RDW Open Data proxy (full merge)
app.get('/api/rdw', async (req, res) => {
  const plate = String(req.query.kenteken || '').replace(/-/g, '').toUpperCase();
  if (!plate) return res.status(400).json({ error: 'kenteken ontbreekt' });

  const headers = {};
  if (process.env.RDW_APP_TOKEN) headers['X-App-Token'] = process.env.RDW_APP_TOKEN;

  const q = async (url) => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`RDW ${r.status} ${r.statusText} for ${url}`);
    return r.json();
  };

  const parseDate = (s) => {
    if (!s || typeof s !== 'string' || s.length !== 8) return null;
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  };

  try {
    // 1) Fetch all relevant datasets in parallel
    const [
      basisArr,
      brandstofArr,
      kleurArr,
      carrosserieArr,
      carroSpecArr,
      asArr
    ] = await Promise.all([
      q(`https://opendata.rdw.nl/resource/m9d7-ebf2.json?kenteken=${plate}`),
      q(`https://opendata.rdw.nl/resource/8ys7-d773.json?kenteken=${plate}`),
      q(`https://opendata.rdw.nl/resource/ihha-7xnj.json?kenteken=${plate}`),
      q(`https://opendata.rdw.nl/resource/vezc-m2t6.json?kenteken=${plate}`),
      q(`https://opendata.rdw.nl/resource/jhie-znh9.json?kenteken=${plate}`),
      q(`https://opendata.rdw.nl/resource/3huj-srit.json?kenteken=${plate}`)
    ]);

    const basis = basisArr?.[0] || {};
    if (!basis.merk && !basis.handelsbenaming) {
      return res.status(404).json({ error: 'Geen voertuig gevonden voor kenteken.' });
    }

    // 2) Normalize/shape datasets
    const fuels = (brandstofArr || []).map(b => ({
      volgnummer: b.brandstof_volgnummer ? Number(b.brandstof_volgnummer) : null,
      omschrijving: b.brandstof_omschrijving || null,
      verbruik_buiten_l_per_100km: b.brandstofverbruik_buiten ? Number(b.brandstofverbruik_buiten) : null,
      verbruik_gecombineerd_l_per_100km: b.brandstofverbruik_gecombineerd ? Number(b.brandstofverbruik_gecombineerd) : null,
      verbruik_stad_l_per_100km: b.brandstofverbruik_stad ? Number(b.brandstofverbruik_stad) : null,
      co2_gecombineerd_g_km: b.co2_uitstoot_gecombineerd ? Number(b.co2_uitstoot_gecombineerd) : null,
      emissiecode_omschrijving: b.emissiecode_omschrijving || null,
      uitlaatemissieniveau: b.uitlaatemissieniveau || null,
      nettomaximumvermogen_kw: b.nettomaximumvermogen ? Number(b.nettomaximumvermogen) : null,
      geluidsniveau_rijdend_db: b.geluidsniveau_rijdend ? Number(b.geluidsniveau_rijdend) : null,
      geluidsniveau_stationair_db: b.geluidsniveau_stationair ? Number(b.geluidsniveau_stationair) : null,
      toerental_geluidsniveau: b.toerental_geluidsniveau ? Number(b.toerental_geluidsniveau) : null
    })).sort((a,b)=> (a.volgnummer||0) - (b.volgnummer||0));

    const kleuren = (kleurArr || []).map(k => ({
      eerste_kleur: k.eerste_kleur || null,
      tweede_kleur: k.tweede_kleur || null
    }));

    const carrosserie = (carrosserieArr || []).map(c => ({
      carrosserie_volgnummer: c.carrosserie_volgnummer ? Number(c.carrosserie_volgnummer) : null,
      carrosserietype_omschrijving: c.carrosserietype_omschrijving || null
    }));

    const carrosserieSpecifiek = (carroSpecArr || []).map(c => ({
      carrosserie_volgnummer: c.carrosserie_volgnummer ? Number(c.carrosserie_volgnummer) : null,
      carrosserietype_omschrijving: c.carrosserietype_omschrijving || null
    }));

    const assen = (asArr || []).map(a => ({
      asnummer: a.asnummer ? Number(a.asnummer) : null,
      spoorbreedte: a.spoorbreedte ? Number(a.spoorbreedte) : null,
      technische_max_aslast: a.technische_max_aslast ? Number(a.technische_max_aslast) : null,
      wielbasis: a.wielbasis ? Number(a.wielbasis) : null,
      aantal_assen: a.aantal_assen ? Number(a.aantal_assen) : null,
      aslast_technisch_toegestaan: a.aslast_technisch_toegestaan ? Number(a.aslast_technisch_toegestaan) : null,
    }));

    // 3) Build summary + details
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
      bpm_bruto: basis.bruto_bpm ? Number(basis.bruto_bpm) : null,
      massa_ledig_kg: basis.massa_ledig_voertuig ? Number(basis.massa_ledig_voertuig) : null,
      massa_rijklaar_kg: basis.massa_rijklaar ? Number(basis.massa_rijklaar) : null,
      trekgewicht_ongeremd_kg: basis.maximum_massa_trekken_ongeremd ? Number(basis.maximum_massa_trekken_ongeremd) : null,
      trekgewicht_geremd_kg: basis.maximum_trekken_massa_geremd ? Number(basis.maximum_trekken_massa_geremd) : null
    };

    const details = {
      basis: {
        voertuigsoort: basis.voertuigsoort || null,
        merk: basis.merk || null,
        handelsbenaming: basis.handelsbenaming || null,
        inrichting: basis.inrichting || null,
        catalogusprijs: basis.catalogusprijs ? Number(basis.catalogusprijs) : null,
        cilinders: basis.aantal_cilinders ? Number(basis.aantal_cilinders) : null,
        cilinderinhoud_cc: basis.cilinderinhoud ? Number(basis.cilinderinhoud) : null,
        lengte_cm: basis.lengte ? Number(basis.lengte) : null,
        breedte_cm: basis.breedte ? Number(basis.breedte) : null,
        hoogte_cm: basis.hoogte_voertuig ? Number(basis.hoogte_voertuig) : null,
        wielbasis_cm: basis.wielbasis ? Number(basis.wielbasis) : null,
        eu_voertuigcategorie: basis.europese_voertuigcategorie || null,
        zuinigheidsclassificatie: basis.zuinigheidsclassificatie || null,
        type: basis.type || null,
        variant: basis.variant || null,
        uitvoering: basis.uitvoering || null,
        typegoedkeuringsnummer: basis.typegoedkeuringsnummer || null,
        datum_eerste_toelating: parseDate(basis.datum_eerste_toelating),
        datum_tenaamstelling: parseDate(basis.datum_tenaamstelling),
        datum_eerste_tenaamstelling_in_nederland: parseDate(basis.datum_eerste_tenaamstelling_in_nederland),
        apk_vervaldatum: parseDate(basis.vervaldatum_apk),
        wam_verzekerd: basis.wam_verzekerd || null,
        export_indicator: basis.export_indicator || null,
        openstaande_terugroepactie_indicator: basis.openstaande_terugroepactie_indicator || null,
        taxi_indicator: basis.taxi_indicator || null,
        tellerstandoordeel: basis.tellerstandoordeel || null
      },
      brandstoffen: fuels,
      kleuren: kleuren,
      carrosserie: carrosserie,
      carrosserie_specifiek: carrosserieSpecifiek,
      assen: assen
    };

    res.json({
      summary,
      details,
      _raw: {
        basis: basisArr,
        brandstof: brandstofArr,
        kleur: kleurArr,
        carrosserie: carrosserieArr,
        carrosserie_specifiek: carroSpecArr,
        assen: asArr
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'RDW service fout', detail: String(e?.message || e) });
  }
});

// --- Health check (optional)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, env: { supabase: !!process.env.SUPABASE_URL, rdwAppToken: !!process.env.RDW_APP_TOKEN } });
});

// --- Static files (serve your HTML from the project root)
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], cacheControl: false }));

// --- Start server
const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  console.log(`E-Noer dev server on http://localhost:${PORT}`);
});