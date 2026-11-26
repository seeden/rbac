// @flow
import Base from './Base';

export default class Permission extends Base {
  /**
   * Compute name of permission from action and resource
   * @function createName
   * @memberof Permission
   * @param {String} action Name of permission
   * @param {String} resource Resource of permission
   * @param {String} delimiter delimiter
   * @return {String} Computed name of permission
   * @static
   */
  static createName(action: string, resource: string, delimiter: string): string {
    if (!delimiter) {
      throw new Error('Delimiter is not defined');
    }

    if (!action) {
      throw new Error('Action is not defined');
    }

    if (!resource) {
      throw new Error('Resource is not defined');
    }

    return `${action}${delimiter}${resource}`;
  }

  static decodeName(name: string, delimiter: string): Object {
    if (!delimiter) {
      throw new Error('delimiter is required');
    }

    if (!name) {
      throw new Error('Name is required');
    }

    const pos = name.indexOf(delimiter);
    if (pos === -1) {
      throw new Error('Wrong name');
    }

    return {
      action: name.slice(0, pos),
      resource: name.slice(pos + delimiter.length),
    };
  }

  /**
   * Permission constructor
   * @constructor Permission
   * @extends {Base}
   * @param {RBAC} rbac Instance of the RBAC
   * @param {string} action Name of the action
   * @param {string} resource Name of the resource
   */
  constructor(rbac: RBAC, action: string, resource: string) {
    if (!action || !resource) {
      throw new Error('One of parameters is undefined');
    }

    if (!Permission.isValidName(action, rbac.options.delimiter) || !Permission.isValidName(resource, rbac.options.delimiter)) {
      throw new Error('Action or resource has no valid name');
    }

    super(rbac, Permission.createName(action, resource, rbac.options.delimiter));
  }

  /**
   * Get action name of actual permission
   * @member Permission#action {String} Action of permission
   */
  get action(): string {
    if (!this._action) {
      const decoded = Permission.decodeName(this.name, this.rbac.options.delimiter);
      if (!decoded) {
        throw new Error('Action is null');
      }

      this._action = decoded.action;
    }

    return this._action;
  }

  /**
   * Get resource name of actual permission
   * @member Permission#resource {String} Resource of permission
   */
  get resource(): string {
    if (!this._resource) {
      const decoded = Permission.decodeName(this.name, this.rbac.options.delimiter);
      if (!decoded) {
        throw new Error('Resource is null');
      }

      this._resource = decoded.resource;
    }

    return this._resource;
  }

  /**
   * Return true if has same action and resource
   * @method Permission#can
   * @param  {String}  action   Name of action
   * @param  {String}  resource Name of resource
   * @return {Boolean}
   */
  can(action: string, resource: string): boolean {
    return this.action === action && this.resource === resource;
  }

  /**
   * Correct name is a non-empty string that contains no whitespace and none of
   * the characters of the delimiter (so encoded permission names stay unambiguous).
   * @function isValidName
   * @memberof Permission
   * @param  {String} name Name
   * @param  {String} delimiter Delimiter
   * @return {Boolean}
   * @static
   */
  static isValidName(name: string, delimiter: string): boolean {
    if (!delimiter || typeof delimiter !== 'string') {
      throw new Error('Delimiter is not defined');
    }

    if (typeof name !== 'string' || name.length === 0 || /\s/.test(name)) {
      return false;
    }

    // Plain character comparison instead of a RegExp built from the delimiter,
    // so delimiters such as `]`, `\` or `^` cannot change the validation rule.
    for (let i = 0; i < delimiter.length; i += 1) {
      if (name.includes(delimiter[i])) {
        return false;
      }
    }

    return true;
  }
}
