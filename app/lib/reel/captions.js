// Builds the subtitle file (ASS format) that draws the captions, the small
// "Dream Reel" footer and the end card onto the video. libass renders it with
// the app's own fonts, so the film matches the app.
import { WIDTH, HEIGHT } from './timeline.js';

function ts(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

/** Makes any user/AI text safe inside an ASS dialogue line. */
export function assText(text) {
  return String(text || '')
    .replace(/[\\{}]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

/**
 * @param {object} p
 * @param {ReturnType<import('./timeline.js').planTimeline>} p.timeline
 * @param {string[]} p.lines    one caption per scene ('' = none)
 * @param {{footer:string, title:string, tagline:string[], domain:string}} p.brand
 */
export function buildAss({ timeline, lines, brand }) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${WIDTH}
PlayResY: ${HEIGHT}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Cormorant Garamond Medium,74,&H00F7F2FF,&H00FFFFFF,&H5A0C0814,&HA0000000,0,1,0,0,100,100,0.5,0,1,7,0,2,100,100,350,1
Style: Footer,DM Sans Medium,26,&H40FFFFFF,&H00FFFFFF,&H780C0814,&H96000000,0,0,0,0,100,100,7,0,1,4,0,2,60,60,110,1
Style: EndTitle,Cormorant Garamond Medium,118,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,0,0,0,0,100,100,1,0,1,0,3,5,60,60,0,1
Style: EndLine,Cormorant Garamond Medium,66,&H00E9E2FF,&H00FFFFFF,&H00000000,&H78000000,0,1,0,0,100,100,0.5,0,1,0,2,5,60,60,0,1
Style: EndDomain,DM Sans Medium,30,&H4DFFFFFF,&H00FFFFFF,&H00000000,&H78000000,0,0,0,0,100,100,6,0,1,0,1.5,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [];
  timeline.scenes.forEach((scene, i) => {
    const text = assText(lines[i]);
    if (!text) return;
    events.push(`Dialogue: 1,${ts(scene.captionStart)},${ts(scene.captionEnd)},Caption,,0,0,0,,{\\fad(450,350)\\blur9}${text}`);
  });

  const { endCard } = timeline;
  // Small, quiet branding while the dream plays — never over the end card.
  if (brand.footer) {
    events.push(`Dialogue: 0,${ts(0.8)},${ts(endCard.start + 0.2)},Footer,,0,0,0,,{\\fad(800,400)\\blur6}${assText(brand.footer).toUpperCase()}`);
  }

  const e0 = endCard.start + 0.35;
  const e1 = endCard.start + endCard.duration;
  events.push(`Dialogue: 2,${ts(e0)},${ts(e1)},EndTitle,,0,0,0,,{\\fad(600,250)\\pos(540,840)}${assText(brand.title)}`);
  (brand.tagline || []).forEach((line, k) => {
    events.push(`Dialogue: 2,${ts(e0 + 0.35 + k * 0.3)},${ts(e1)},EndLine,,0,0,0,,{\\fad(600,250)\\pos(540,${990 + k * 80})}${assText(line)}`);
  });
  if (brand.domain) {
    events.push(`Dialogue: 2,${ts(e0 + 0.9)},${ts(e1)},EndDomain,,0,0,0,,{\\fad(600,250)\\pos(540,1250)}${assText(brand.domain)}`);
  }
  return header + events.join('\n') + '\n';
}
