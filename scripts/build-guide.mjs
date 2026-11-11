// Writes docs/guide.md from the in-app Help (app/src/help-content.js), so the two never differ.
import { writeFileSync } from 'node:fs';
import { HELP } from '../app/src/help-content.js';

const md = (html) =>
  html
    .replace(/\(\{\{RULE:[A-Z_]+\}\}\)/g, '(see the Rules screen)')
    .replace(/\{\{RULE:([A-Z_]+)\}\}/g, 'the value on the Rules screen')
    .replace(/<a [^>]*data-help="([\w-]+)"[^>]*>(.*?)<\/a>/g, '[$2](#$1)')
    .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
    .replace(/<em>(.*?)<\/em>/g, '*$1*')
    .replace(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g, '- **$1**: $2\n')
    .replace(/<\/?(dl|ul)[^>]*>/g, '\n')
    .replace(/<ol>([\s\S]*?)<\/ol>/g, (_m, inner) => `\n${inner.split(/<li>/).slice(1).map((li, i) => `${i + 1}. ${li.replace(/<\/li>/, '').trim()}`).join('\n')}\n`)
    .replace(/<li>([\s\S]*?)<\/li>/g, '- $1')
    .replace(/<p>([\s\S]*?)<\/p>/g, '\n$1\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const out = `# Mandate guide

The same guide is in the app (Help). Rule values shown there are your community's current ones.

${HELP.map((s) => `<a id="${s.id}"></a>\n## ${s.title}\n\n${md(s.html)}`).join('\n\n')}
`;
writeFileSync(new URL('../docs/guide.md', import.meta.url), out);
console.log('wrote docs/guide.md');
