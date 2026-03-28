# RBAC

Hierarchical Role Based Access Control for Node.js

[![NPM version](https://img.shields.io/npm/v/rbac.svg)](https://www.npmjs.com/package/rbac)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

```sh
npm install rbac
```

## Usage

```js
import { RBAC } from 'rbac';

const rbac = new RBAC({
  roles: ['superadmin', 'admin', 'user', 'guest'],
  permissions: {
    user: ['create', 'delete'],
    password: ['change', 'forgot'],
    article: ['create'],
    rbac: ['update'],
  },
  grants: {
    guest: ['create_user', 'forgot_password'],
    user: ['change_password'],
    admin: ['user', 'delete_user', 'update_rbac'],
    superadmin: ['admin'],
  },
});

await rbac.init();
```

## Check permissions

```js
const can = await rbac.can('admin', 'create', 'article');
if (can) {
  console.log('Admin is able to create article');
}
```

Or use a role instance:

```js
const admin = await rbac.getRole('admin');
if (!admin) {
  console.log('Role does not exist');
} else {
  const can = await admin.can('create', 'article');
  if (can) {
    console.log('Admin is able to create article');
  }
}
```

## Custom storage

RBAC uses in-memory storage by default. You can implement custom storage by extending the `Storage` class:

```js
import { Storage } from 'rbac';

class MyStorage extends Storage {
  async add(item) { /* ... */ }
  async remove(item) { /* ... */ }
  async grant(role, child) { /* ... */ }
  async revoke(role, child) { /* ... */ }
  async get(name) { /* ... */ }
  async getRoles() { /* ... */ }
  async getPermissions() { /* ... */ }
  async getGrants(role) { /* ... */ }
}

const rbac = new RBAC({ storage: new MyStorage() });
```

## Running Tests

```sh
npm test
```

## Credits

[Zlatko Fedor](https://github.com/seeden)

## License

MIT
