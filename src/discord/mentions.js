/**
 * Turn stored target tokens (everyone | here | user:<id>) into a mention
 * prefix string plus the matching discord.js allowedMentions object, so the ping is
 * actually delivered (and nothing unintended is pinged).
 */
export function buildMentions(tokens = []) {
  const parts = [];
  const users = [];
  let everyone = false;

  for (const token of tokens) {
    if (token === 'everyone') {
      parts.push('@everyone');
      everyone = true;
    } else if (token === 'here') {
      parts.push('@here');
      everyone = true; // discord.js "everyone" parse covers @here too
    } else if (token.startsWith('user:')) {
      const id = token.slice(5);
      parts.push(`<@${id}>`);
      users.push(id);
    }
  }

  const allowedMentions = { parse: everyone ? ['everyone'] : [] };
  if (users.length) allowedMentions.users = users;

  return { content: parts.join(' '), allowedMentions };
}

export default { buildMentions };
