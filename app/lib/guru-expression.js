// Picks Orin's facial expression for a reply. Pure and cheap (no extra AI call),
// safe in the browser and on the server. The expression only nudges brows, eyes,
// tilt and light on the avatar — it never changes who Orin is.
export const EXPRESSIONS = ['neutral', 'warm', 'curious', 'thoughtful', 'concerned', 'amused', 'surprised'];

const RULES = [
  ['concerned', /\b(sorry|frightening|scary|scared|afraid|grief|loss|lost (him|her|them)|hard for you|painful|anxious|anxiety|worried|alone|crisis|harm|hurt)\b/i],
  ['surprised', /\b(remarkable|extraordinary|how unusual|rarely|astonishing|what a)\b|!\s*$/i],
  ['amused', /\b(ha|haha|smile|playful|funny|laugh|delightful|cheeky|mischie)/i],
  ['curious', /\?\s*$|\b(i wonder|tell me|what do you|who was|did you|have you)\b/i],
  ['thoughtful', /\b(perhaps|consider|reflect|meaning|symbol|tradition|jung|might suggest|could reflect|in many traditions)\b/i],
  ['warm', /\b(you|your)\b.*\b(kind|gentle|care|love|safe|well|courage|strength|hope)\b|\b(welcome|glad|lovely|beautiful)\b/i],
];

export function expressionFor(text) {
  const t = String(text || '').slice(-600);
  for (const [name, re] of RULES) if (re.test(t)) return name;
  return 'neutral';
}
