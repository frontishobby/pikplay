// Supabase Edge Function entry point. Deploy with JWT verification off (see
// supabase/config.toml): the Authorization header carries the PikPak token, not
// a Supabase key, and handler.ts does its own check against PIKPAK_PAT.
import { createRelay } from './handler.ts'

Deno.serve(createRelay({ token: Deno.env.get('PIKPAK_PAT') ?? '' }))
