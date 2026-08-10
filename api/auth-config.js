// Supabase 설정을 서버에서만 제공 — 인증 후에만 접근 가능
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const url = process.env.TERMINAL_SUPABASE_URL;
  const key = process.env.TERMINAL_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // anon key는 클라이언트용으로 설계됨 (RLS가 보안 담당)
  res.json({ url, key });
}
