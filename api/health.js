export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, order: false, live: false, pin: false, tg: false });
}
