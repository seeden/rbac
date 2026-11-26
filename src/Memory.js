// @flow
import Storage from './Storage';
import Permission from './Permission';
import Role from './Role';
import Base from './Base';

export default class Memory extends Storage {
  // A Map (not a plain object) so names such as `constructor`, `toString`
  // or `__proto__` are ordinary keys and never collide with Object.prototype.
  items: Map<string, { instance: Base, grants: string[] }> = new Map();

  async add(item: Base): Promise<boolean> {
    const { name } = item;
    if (this.items.has(name)) {
      throw new Error(`Item ${name} already exists`);
    }

    this.items.set(name, {
      instance: item,
      grants: [],
    });

    return true;
  }

  async remove(item: Base): Promise<boolean> {
    const { items } = this;
    const { name } = item;
    if (!items.has(name)) {
      throw new Error(`Item ${name} is not presented in storage`);
    }

    // revoke from all instances
    items.forEach((entry) => {
      if (entry.grants.includes(name)) {
        // eslint-disable-next-line no-param-reassign
        entry.grants = entry.grants.filter(grant => grant !== name);
      }
    });

    // delete from items
    items.delete(name);
    return true;
  }

  async grant(role: Role, child: Base): Promise<boolean> {
    const { name } = role;
    const { name: childName } = child;

    if (!this.items.has(name)) {
      throw new Error(`Role ${name} is not exist`);
    }

    if (!this.items.has(childName)) {
      throw new Error(`Base ${childName} is not exist`);
    }

    if (!(role instanceof Role)) {
      throw new Error('Role is not instance of Role');
    }

    if (name === childName) {
      throw new Error(`You can't grant yourself ${name}`);
    }

    const { grants } = this.items.get(name);
    if (!grants.includes(childName)) {
      grants.push(childName);
    }

    return true;
  }

  async revoke(role: Role, child: Base): Promise<boolean> {
    const { name } = role;
    const { name: childName } = child;

    if (!this.items.has(name) || !this.items.has(childName)) {
      throw new Error('Role is not exist');
    }

    const entry = this.items.get(name);
    if (!entry.grants.includes(childName)) {
      throw new Error('Item is not associated to this item');
    }

    entry.grants = entry.grants.filter(grant => grant !== childName);

    return true;
  }

  async get(name: string): Promise<?Base> {
    if (name && this.items.has(name)) {
      return this.items.get(name).instance;
    }

    return undefined;
  }

  async getRoles(): Promise<Role[]> {
    return Array.from(this.items.values())
      .map(({ instance }) => instance)
      .filter(instance => instance instanceof Role);
  }

  async getPermissions(): Promise<Permission[]> {
    return Array.from(this.items.values())
      .map(({ instance }) => instance)
      .filter(instance => instance instanceof Permission);
  }

  async getGrants(role: string): Promise<Base[]> {
    if (role && this.items.has(role)) {
      return this.items.get(role).grants.reduce((filtered: Base[], grantName: string) => {
        const grant = this.items.get(grantName);
        if (grant) {
          filtered.push(grant.instance);
        }

        return filtered;
      }, []);
    }

    return [];
  }
}
