import { RBAC, Permission, Memory } from './index';

async function setup(options = {}) {
  const rbac = new RBAC({
    roles: ['admin', 'user'],
    permissions: { article: ['create', 'update'], user: ['delete'] },
    grants: {
      user: ['create_article'],
      admin: ['user', 'delete_user'],
    },
    ...options,
  });
  await rbac.init();
  return rbac;
}

describe('Memory#getRoles / getPermissions', () => {
  it('lists roles', async () => {
    const rbac = await setup();
    const names = (await rbac.getRoles()).map(role => role.name).sort();
    expect(names).toEqual(['admin', 'user']);
  });

  it('lists permissions', async () => {
    const rbac = await setup();
    const names = (await rbac.getPermissions()).map(p => p.name).sort();
    expect(names).toEqual(['create_article', 'delete_user', 'update_article']);
  });

  it('returns empty lists for an empty storage', async () => {
    const rbac = new RBAC({ storage: new Memory() });
    expect(await rbac.getRoles()).toEqual([]);
    expect(await rbac.getPermissions()).toEqual([]);
  });
});

describe('canAll / canAny with empty or duplicate input', () => {
  it('canAll with an empty list is false (fail closed)', async () => {
    const rbac = await setup();
    expect(await rbac.canAll('admin', [])).toBe(false);
    expect(await rbac.canAll('does-not-exist', [])).toBe(false);
  });

  it('canAny with an empty list is false', async () => {
    const rbac = await setup();
    expect(await rbac.canAny('admin', [])).toBe(false);
  });

  it('canAll tolerates duplicate entries', async () => {
    const rbac = await setup();
    expect(await rbac.canAll('admin', [
      ['create', 'article'],
      ['create', 'article'],
    ])).toBe(true);
  });

  it('canAll is still false when one permission is missing', async () => {
    const rbac = await setup();
    expect(await rbac.canAll('user', [
      ['create', 'article'],
      ['delete', 'user'],
    ])).toBe(false);
  });
});

describe('names that collide with Object.prototype keys', () => {
  const reserved = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

  it('can create, grant and check roles with reserved names', async () => {
    const rbac = await setup({ roles: ['admin', 'user', ...reserved] });

    for (let i = 0; i < reserved.length; i += 1) {
      const name = reserved[i];
      // eslint-disable-next-line no-await-in-loop
      expect(await rbac.existsRole(name)).toBe(true);
      // eslint-disable-next-line no-await-in-loop
      expect(await rbac.can(name, 'create', 'article')).toBe(false);
    }

    await rbac.grantByName('constructor', 'create_article');
    expect(await rbac.can('constructor', 'create', 'article')).toBe(true);
  });

  it('traverses into a child role named constructor', async () => {
    const rbac = await setup({ roles: ['admin', 'user', 'constructor'] });
    await rbac.grantByName('constructor', 'update_article');
    await rbac.grantByName('admin', 'constructor');

    expect(await rbac.can('admin', 'update', 'article')).toBe(true);
    expect(await rbac.hasRole('admin', 'constructor')).toBe(true);
  });

  it('unknown reserved names do not exist', async () => {
    const rbac = await setup();
    expect(await rbac.exists('toString')).toBe(false);
    expect(await rbac.can('toString', 'create', 'article')).toBe(false);
  });

  it('__proto__ is an ordinary name with a non-default delimiter', async () => {
    const rbac = await setup({
      delimiter: ':',
      roles: ['admin', '__proto__'],
      permissions: { article: ['create'] },
      grants: { ['__proto__']: ['create:article'] }, // eslint-disable-line no-useless-computed-key
    });

    expect(await rbac.can('__proto__', 'create', 'article')).toBe(true);
    // storage integrity: unrelated lookups must not resolve through the prototype
    expect(await rbac.exists('instance')).toBe(false);
    expect(await rbac.exists('grants')).toBe(false);
    expect((await rbac.getRoles()).map(r => r.name).sort()).toEqual(['__proto__', 'admin']);
  });
});

describe('delimiter handling', () => {
  it('rejects empty names, whitespace and the delimiter', () => {
    expect(Permission.isValidName('', '_')).toBe(false);
    expect(Permission.isValidName('a b', '_')).toBe(false);
    expect(Permission.isValidName('a_b', '_')).toBe(false);
    expect(Permission.isValidName('admin', '_')).toBe(true);
  });

  it('treats regex metacharacters as literal delimiters', () => {
    expect(Permission.isValidName('admin', ']')).toBe(true);
    expect(Permission.isValidName('a]b', ']')).toBe(false);

    expect(Permission.isValidName('users', '\\')).toBe(true);
    expect(Permission.isValidName('a b', '\\')).toBe(false);
    expect(Permission.isValidName('a\\b', '\\')).toBe(false);

    expect(Permission.isValidName('a^b', '^')).toBe(false);
    expect(Permission.isValidName('a-b', '-')).toBe(false);
    expect(Permission.isValidName('ab', '-')).toBe(true);
  });

  it('decodes multi-character delimiters', () => {
    expect(Permission.decodeName('create::article', '::')).toEqual({
      action: 'create',
      resource: 'article',
    });
  });

  it('rejects names containing any character of a multi-character delimiter', () => {
    expect(Permission.isValidName('a:b', '::')).toBe(false);
  });

  it('works end to end with a multi-character delimiter', async () => {
    const rbac = await setup({
      delimiter: '::',
      roles: ['admin'],
      permissions: { article: ['create'] },
      grants: { admin: ['create::article'] },
    });

    expect(await rbac.can('admin', 'create', 'article')).toBe(true);
    const permission = await rbac.getPermissionByName('create::article');
    expect(permission.action).toBe('create');
    expect(permission.resource).toBe('article');
  });

  it('works end to end with a regex metacharacter delimiter', async () => {
    const rbac = await setup({
      delimiter: ']',
      roles: ['admin'],
      permissions: { article: ['create'] },
      grants: { admin: ['create]article'] },
    });

    expect(await rbac.can('admin', 'create', 'article')).toBe(true);
  });
});

describe('Memory#remove', () => {
  it('revokes the removed item from every role', async () => {
    const rbac = await setup();
    await rbac.removeByName('create_article');

    expect(await rbac.can('user', 'create', 'article')).toBe(false);
    expect(await rbac.can('admin', 'create', 'article')).toBe(false);
    expect(await rbac.can('admin', 'delete', 'user')).toBe(true);
  });
});
