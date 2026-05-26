export const meta = {
  name: 'Temple Heal',
  conditions: [{ type: 'party-location', operator: 'equals', value: 'Temple of Light' }],
  effects: [{ type: 'story', instruction: 'The temple light heals the wounded.' }],
  recurring: true
};
const partyHealth = check({ type: 'player-resource', resource: 'health' });
if (Object.values(partyHealth).every((health) => 10 <= health)) {
  skip = true;
} else {
  log('healing party from',JSON.stringify(partyHealth));
  effects.push({ type: 'player-resource', resource: 'health', operator: 'add', value: 5 });
}
