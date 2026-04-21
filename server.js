const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_KEY    = process.env.GOOGLE_PLACES_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ProfileScout API running' });
});

app.get('/api/search', async (req, res) => {
  const { query } = req.query;
  if (!query)      return res.status(400).json({ error: 'query is required' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured on server' });

  try {
    const searchRes = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.photos,places.regularOpeningHours,places.types',
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: 12 }),
      }
    );

    const searchData = await searchRes.json();

    if (searchData.error) {
      console.error('Google error:', JSON.stringify(searchData.error));
      return res.status(403).json({ error: `Google API error: ${searchData.error.message}` });
    }

    if (!searchData.places?.length) {
      return res.json({ businesses: [] });
    }

    const typeMap = {
      restaurant:'Restaurant', food:'Restaurant', cafe:'Restaurant',
      store:'Retail', clothing_store:'Retail',
      hair_care:'Salon', beauty_salon:'Salon', spa:'Salon',
      car_repair:'Auto', car_dealer:'Auto',
      gym:'Health', doctor:'Health',
      general_contractor:'Contractor', plumber:'Contractor', electrician:'Contractor',
      lawyer:'Legal', dentist:'Dental',
    };

    const businesses = searchData.places.map((place, i) => {
      const hasPhotos  = !!(place.photos?.length > 0);
      const hasHours   = !!(place.regularOpeningHours?.weekdayDescriptions?.length);
      const hasWebsite = !!place.websiteUri;
      const hasPhone   = !!place.nationalPhoneNumber;
      const rating     = place.rating || null;
      const reviews    = place.userRatingCount || 0;
      const likelyClaimed = hasPhone || hasHours || hasWebsite || reviews > 0;

      const issues = [];
      if (!likelyClaimed) issues.push('unclaimed');
      if (!hasPhotos)     issues.push('no-photos');
      if (!hasHours)      issues.push('no-hours');
      if (!hasWebsite)    issues.push('no-website');
      if (reviews === 0)  issues.push('no-reviews');
      if (rating !== null && rating < 3.5) issues.push('low-rating');

      const addrParts   = (place.formattedAddress || '').split(',');
      const detectedCat = place.types?.map(t => typeMap[t.toLowerCase()]).find(Boolean) || 'Business';
      const placeId     = place.id || `place_${i}`;

      return {
        id:      `gpl_${placeId.slice(-8)}`,
        name:    place.displayName?.text || 'Unknown',
        cat:     detectedCat,
        addr:    addrParts[0]?.trim() || '',
        city:    addrParts.slice(1, 3).join(',').trim() || '',
        phone:   place.nationalPhoneNumber || null,
        website: hasWebsite,
        photos:  place.photos?.length || 0,
        hours:   hasHours,
        claimed: likelyClaimed,
        rating,
        reviews,
        issues,
        placeId,
      };
    });

    res.json({ businesses });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

app.post('/api/outreach', async (req, res) => {
  const { business, tone } = req.body;
  if (!business)      return res.status(400).json({ error: 'business is required' });
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
  const prompt = tone === 'SMS'
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
