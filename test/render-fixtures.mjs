import { renderHill } from '../src/render.mjs';

const fixtures = [
  [],
  [0, 50, 100, 25].map((position, i) => ({ number: i + 1, position, title: `<Scope "${i}"> & 'Ünïcödé ✓ 漢字'` })),
  Array.from({ length: 40 }, (_, i) => ({ number: i + 1, position: 50, title: `Overlapping scope ${i}` })),
];
console.log(JSON.stringify(fixtures.map(scopes => renderHill({ number: 100, title: 'Pitch <&"\'> Ünïcödé' }, scopes))));
