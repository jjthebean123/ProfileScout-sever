const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Your API keys live here on the server, never sent to users ──
const GOOGLE_KEY     = process.env.GOOGLE_PLACES_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;

app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ProfileScout API running' });
});

// ── SEARCH: find businesses via Google Places ─────────────────
// GET /api/search?query=restaurants+in+Austin+TX
app.get('/api/search', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured on server' });

  try {
    // Step 1: Text search
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_KEY}`;
    const searchRes  = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (searchData.status === 'REQUEST_DENIED') {
      return res.status(403).json({ error: 'Google API key invalid or Places API not enabled.' });
    }
    if (!searchData.results?.length) {
      return res.json({ businesses: [] });
    }

    // Step 2: Get full details for each place (up to 12)
    const places  = searchData.results.slice(0, 12);
    const fields  = 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,photos,opening_hours,place_id,types';

    const details = await Promise.all(
      places.map(p =>
        fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=${fields}&key=${GOOGLE_KEY}`)
          .then(r => r.json())
          .then(d => d.result)
          .catch(() => null)
      )
    );

    // Step 3: Transform into ProfileScout format
    const typeMap = {
      restaurant:'Restaurant', food:'Restaurant', cafe:'Restaurant',
      store:'Retail', clothing_store:'Retail',
      hair_care:'Salon', beauty_salon:'Salon', spa:'Salon',
      car_repair:'Auto', car_dealer:'Auto',
      gym:'Health', doctor:'Health', health:'Health',
      general_contractor:'Contractor', plumber:'Contractor', electrician:'Contractor',
      lawyer:'Legal', dentist:'Dental',
    };

    const businesses = details.filter(Boolean).map((place, i) => {
      const hasPhotos  = !!(place.photos?.length > 0);
      const hasHours   = !!(place.opening_hours?.weekday_text?.length);
      const hasWebsite = !!place.website;
      const hasPhone   = !!place.formatted_phone_number;
      const rating     = place.rating   || null;
      const reviews    = place.user_ratings_total || 0;
      const likelyClaimed = hasPhone || hasHours || hasWebsite || reviews > 0;

      const issues = [];
      if (!likelyClaimed) issues.push('unclaimed');
      if (!hasPhotos)     issues.push('no-photos');
      if (!hasHours)      issues.push('no-hours');
      if (!hasWebsite)    issues.push('no-website');
      if (reviews === 0)  issues.push('no-reviews');
      if (rating !== null && rating < 3.5) issues.push('low-rating');

      const addrParts  = (place.formatted_address || '').split(',');
      const detectedCat = place.types?.map(t => typeMap[t]).find(Boolean) || 'Business';

      return {
        id:      `gpl_${place.place_id?.slice(-8) || i}`,
        name:    place.name,
        cat:     detectedCat,
        addr:    addrParts[0]?.trim() || '',
        city:    addrParts.slice(1, 3).join(',').trim() || '',
        phone:   place.formatted_phone_number || null,
        website: hasWebsite,
        photos:  place.photos?.length || 0,
        hours:   hasHours,
        claimed: likelyClaimed,
        rating,
        reviews,
        issues,
        placeId: place.place_id,
      };
    });

    res.json({ businesses });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// ── OUTREACH: generate email/SMS via Claude ───────────────────
// POST /api/outreach  body: { business, tone }
app.post('/api/outreach', async (req, res) => {
  const { business, tone } = req.body;
  if (!business) return res.status(400).json({ error: 'business is required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic key not configured on server' });

  const ISSUE_LABELS = {
    'unclaimed':  'Unclaimed profile',
    'no-photos':  'No photos',
    'no-hours':   'Hours missing',
    'no-website': 'No website link',
    'no-reviews': 'No reviews',
    'low-rating': 'Low rating (under 3.5)',
  };

  const issueList = business.issues.map(i => ISSUE_LABELS[i] || i).join(', ');
  const isSMS     = tone === 'SMS';

  const prompt = isSMS
    ? `Write a casual SMS under 160 chars to the owner of "${business.name}" offering Google Business Profile optimization. Their issues: ${issueList}. End with a question. No subject line.`
    : `Write a ${tone.toLowerCase()} cold outreach email to the owner of "${business.name}", a ${business.cat} at ${business.addr}, ${business.city}. Their Google Business Profile issues: ${issueList}. Offer professional GBP optimization. Under 200 words. Include a subject line at the top.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    const text   = aiData.content?.map(c => c.text || '').join('') || 'Could not generate outreach.';
    res.json({ text });

  } catch (err) {
    console.error('Outreach error:', err);
    res.status(500).json({ error: 'Could not generate outreach. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`ProfileScout server running on port ${PORT}`));
