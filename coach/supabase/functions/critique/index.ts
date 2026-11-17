// AI critique endpoint. The API key lives only here (Supabase function secret ANTHROPIC_API_KEY).
// Flow: check login → check monthly cap → send the (downscaled) photo for critique →
// record cost in the ledger → save the critique. The photo itself is never stored here.
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import {
  cleanResult,
  costUsd,
  critiqueSchema,
  isPaidTier,
  MAX_OUTPUT_TOKENS,
  monthStartLA,
  SYSTEM_PROMPT,
  TAGS,
  TIERS,
  type PaidTier,
  type Tag,
  userPrompt,
  worstCaseUsd,
} from '../_shared/critique.ts';

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const serviceKey = () => {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  // Newer projects expose secret keys as a JSON map
  try {
    const m = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    return (Object.values(m)[0] as string) ?? '';
  } catch {
    return '';
  }
};

interface Body {
  photo_id: string;
  image: string; // base64 JPEG, no data: prefix
  media_type?: 'image/jpeg' | 'image/png' | 'image/webp';
  /** cheap | better | best (defaults to the Settings choice) */
  tier?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, serviceKey(), { auth: { persistSession: false } });

  // ---- who is calling ----
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Please sign in again.' });
  const userId = userData.user.id;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Bad request' });
  }
  if (!body.photo_id || !body.image || body.image.length > 8_000_000) return json(400, { error: 'Missing or too-large photo' });

  // The photo row must be the caller's own
  const { data: photo } = await admin
    .from('photos')
    .select('id, source, exif, live_score, note')
    .eq('id', body.photo_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!photo) return json(404, { error: 'Photo not found' });

  // ---- settings + cap ----
  const { data: settings } = await admin.from('settings').select('*').eq('user_id', userId).maybeSingle();
  if (settings && settings.ai_critique === false) return json(403, { error: 'AI critique is turned off in Settings.' });
  const cap = Number(settings?.monthly_cap_usd ?? 5);
  const editingTips = settings?.editing_tips ?? true;
  const effort = settings?.depth === 'thorough' ? 'medium' : 'low';
  const tierKey: PaidTier = isPaidTier(body.tier) ? body.tier : isPaidTier(settings?.model_tier) ? settings.model_tier : 'cheap';
  const tier = TIERS[tierKey];
  const MODEL = tier.model;
  const WORST_CASE_USD = worstCaseUsd(tierKey);

  const since = monthStartLA(new Date());
  const { data: spentRows, error: spendErr } = await admin
    .from('api_usage')
    .select('cost_usd')
    .eq('user_id', userId)
    .gte('created_at', since);
  if (spendErr) return json(500, { error: 'Could not check spending' });
  const spent = (spentRows ?? []).reduce((a, r) => a + Number(r.cost_usd), 0);
  if (spent + WORST_CASE_USD > cap) {
    return json(402, {
      error: `Monthly cap reached ($${spent.toFixed(2)} of $${cap.toFixed(2)}). Raise it in Settings or wait until the 1st.`,
      spent,
      cap,
    });
  }

  // Recurring habits from recent critiques, so the coach can follow up
  const { data: recent } = await admin
    .from('critiques')
    .select('tags')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  const counts = new Map<string, number>();
  for (const r of recent ?? []) for (const t of (r.tags ?? []) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
  const recurring = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => TAGS[t as Tag]?.label ?? t);

  // ---- ask Claude ----
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json(500, { error: 'The AI key is not set up yet (ANTHROPIC_API_KEY).' });
  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // If the model declines, a backup model finishes the job (not available on the cheapest tier)
      ...(tier.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      output_config: {
        effort,
        format: { type: 'json_schema', schema: critiqueSchema(editingTips) },
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: body.media_type ?? 'image/jpeg', data: body.image } },
            {
              type: 'text',
              text: userPrompt({
                editingTips,
                exif: photo.exif,
                source: photo.source,
                liveScore: photo.live_score,
                note: photo.note,
                recurring,
              }),
            },
          ],
        },
      ],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json(502, { error: 'The AI key was rejected. Check ANTHROPIC_API_KEY.' });
    if (e instanceof Anthropic.RateLimitError) return json(429, { error: 'Too many requests right now. Try again in a minute.' });
    if (e instanceof Anthropic.BadRequestError) return json(400, { error: `The AI couldn't read this photo (${e.message}).` });
    if (e instanceof Anthropic.APIError) return json(502, { error: `AI service error (${e.status}). Try again.` });
    return json(502, { error: 'Could not reach the AI service. Try again.' });
  }

  // ---- record cost first (even for refusals: they can still bill) ----
  const models: string[] = [MODEL];
  if (response.model && response.model !== MODEL) models.push(response.model);
  const usage = response.usage;
  const inputTokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  const cost = costUsd(models, inputTokens, outputTokens);
  const { data: ledger } = await admin
    .from('api_usage')
    .insert({ user_id: userId, photo_id: photo.id, model: response.model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost })
    .select('id')
    .single();

  const monthSpent = spent + cost;
  if (response.stop_reason === 'refusal') {
    return json(422, { error: 'The AI declined to critique this photo.', cost_usd: cost, spent: monthSpent, cap });
  }
  if (response.stop_reason === 'max_tokens') {
    return json(502, { error: 'The critique was cut off. Try again.', cost_usd: cost, spent: monthSpent, cap });
  }

  const text = response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(502, { error: 'The AI sent back something unreadable. Try again.', cost_usd: cost, spent: monthSpent, cap });
  }
  const result = cleanResult(parsed, editingTips);

  const { data: critique, error: saveErr } = await admin
    .from('critiques')
    .insert({
      user_id: userId,
      photo_id: photo.id,
      model: response.model,
      score: result.score,
      result,
      tags: result.tags,
      cost_usd: cost,
      usage_id: ledger?.id ?? null,
    })
    .select('*')
    .single();
  if (saveErr) return json(500, { error: 'Critique done but not saved. Try again.', cost_usd: cost, spent: monthSpent, cap });

  return json(200, { critique, spent: monthSpent, cap });
});
