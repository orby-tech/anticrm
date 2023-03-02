//
// Copyright © 2023 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  Account,
  AttachedDoc,
  Class,
  Doc,
  DocumentQuery,
  FindOptions,
  FindResult,
  LookupData,
  MeasureContext,
  ObjQueryType,
  Position,
  PullArray,
  Ref,
  ServerStorage,
  Space,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { Middleware, SessionContext, TxMiddlewareResult } from '@hcengineering/server-core'
import { BaseMiddleware } from './base'
import { getUser, mergeTargets } from './utils'

/**
 * @public
 */
export class SpaceSecurityMiddleware extends BaseMiddleware implements Middleware {
  private allowedSpaces: Record<Ref<Account>, Ref<Space>[]> = {}
  private privateSpaces: Record<Ref<Space>, Space | undefined> = {}
  private publicSpaces: Ref<Space>[] = []
  private readonly systemSpaces = [
    core.space.Configuration,
    core.space.DerivedTx,
    core.space.Model,
    core.space.Space,
    core.space.Tx
  ]

  private constructor (storage: ServerStorage, next?: Middleware) {
    super(storage, next)
  }

  static async create (
    ctx: MeasureContext,
    storage: ServerStorage,
    next?: Middleware
  ): Promise<SpaceSecurityMiddleware> {
    const res = new SpaceSecurityMiddleware(storage, next)
    await res.init(ctx)
    return res
  }

  private addMemberSpace (member: Ref<Account>, space: Ref<Space>): void {
    const arr = this.allowedSpaces[member] ?? []
    arr.push(space)
    this.allowedSpaces[member] = arr
  }

  private addSpace (space: Space): void {
    this.privateSpaces[space._id] = space
    for (const member of space.members) {
      this.addMemberSpace(member, space._id)
    }
  }

  private async init (ctx: MeasureContext): Promise<void> {
    const spaces = await this.storage.findAll(ctx, core.class.Space, { private: true })
    for (const space of spaces) {
      this.addSpace(space)
    }
    this.publicSpaces = (await this.storage.findAll(ctx, core.class.Space, { private: false })).map((p) => p._id)
  }

  private removeMemberSpace (member: Ref<Account>, space: Ref<Space>): void {
    const arr = this.allowedSpaces[member]
    if (arr !== undefined) {
      const index = arr.findIndex((p) => p === space)
      if (index !== -1) {
        arr.splice(index, 1)
        this.allowedSpaces[member] = arr
      }
    }
  }

  private removeSpace (_id: Ref<Space>): void {
    const space = this.privateSpaces[_id]
    if (space !== undefined) {
      for (const member of space.members) {
        this.removeMemberSpace(member, space._id)
      }
      this.privateSpaces[_id] = undefined
    }
  }

  private handleCreate (tx: TxCUD<Space>): void {
    const createTx = tx as TxCreateDoc<Space>
    if (!this.storage.hierarchy.isDerived(createTx.objectClass, core.class.Space)) return
    if (createTx.attributes.private) {
      const res = TxProcessor.buildDoc2Doc<Space>([createTx])
      if (res !== undefined) {
        this.addSpace(res)
      }
    } else {
      this.publicSpaces.push(createTx.objectId)
    }
  }

  private pushMembersHandle (addedMembers: Ref<Account> | Position<Ref<Account>>, space: Ref<Space>): void {
    if (typeof addedMembers === 'object') {
      for (const member of addedMembers.$each) {
        this.addMemberSpace(member, space)
      }
    } else {
      this.addMemberSpace(addedMembers, space)
    }
  }

  private pullMembersHandle (removedMembers: Partial<Ref<Account>> | PullArray<Ref<Account>>, space: Ref<Space>): void {
    if (typeof removedMembers === 'object') {
      const { $in } = removedMembers as PullArray<Ref<Account>>
      if ($in !== undefined) {
        for (const member of $in) {
          this.removeMemberSpace(member, space)
        }
      }
    } else {
      this.removeMemberSpace(removedMembers, space)
    }
  }

  private syncMembers (members: Ref<Account>[], space: Ref<Space>): void {
    const oldMembers = new Set(members)
    const newMembers = new Set(members)
    for (const old of oldMembers) {
      if (!oldMembers.has(old)) {
        this.removeMemberSpace(old, space)
      }
    }
    for (const newMem of newMembers) {
      if (!newMembers.has(newMem)) {
        this.addMemberSpace(newMem, space)
      }
    }
  }

  private removePublicSpace (_id: Ref<Space>): void {
    const publicIndex = this.publicSpaces.findIndex((p) => p === _id)
    if (publicIndex !== -1) {
      this.publicSpaces.splice(publicIndex, 1)
    }
  }

  private async handleUpdate (ctx: SessionContext, tx: TxCUD<Space>): Promise<void> {
    const updateDoc = tx as TxUpdateDoc<Space>
    if (!this.storage.hierarchy.isDerived(updateDoc.objectClass, core.class.Space)) return

    if (updateDoc.operations.private !== undefined) {
      if (updateDoc.operations.private) {
        const res = (await this.storage.findAll(ctx, core.class.Space, { _id: updateDoc.objectId }))[0]
        if (res !== undefined) {
          res.private = true
          this.addSpace(res)
          this.removePublicSpace(res._id)
        }
      } else if (!updateDoc.operations.private) {
        this.removeSpace(updateDoc.objectId)
        this.publicSpaces.push(updateDoc.objectId)
      }
    }

    let space = this.privateSpaces[updateDoc.objectId]
    if (space !== undefined) {
      if (updateDoc.operations.members !== undefined) {
        this.syncMembers(updateDoc.operations.members, space._id)
      }
      if (updateDoc.operations.$push?.members !== undefined) {
        this.pushMembersHandle(updateDoc.operations.$push.members, space._id)
      }

      if (updateDoc.operations.$pull?.members !== undefined) {
        this.pullMembersHandle(updateDoc.operations.$pull.members, space._id)
      }
      space = TxProcessor.updateDoc2Doc(space, updateDoc)
    }
  }

  private handleRemove (tx: TxCUD<Space>): void {
    const removeTx = tx as TxRemoveDoc<Space>
    if (!this.storage.hierarchy.isDerived(removeTx.objectClass, core.class.Space)) return
    if (removeTx._class !== core.class.TxCreateDoc) return
    this.removeSpace(tx.objectId)
    this.removePublicSpace(tx.objectId)
  }

  private async handleTx (ctx: SessionContext, tx: TxCUD<Space>): Promise<void> {
    if (tx._class === core.class.TxCreateDoc) {
      this.handleCreate(tx)
    } else if (tx._class === core.class.TxUpdateDoc) {
      await this.handleUpdate(ctx, tx)
    } else if (tx._class === core.class.TxRemoveDoc) {
      this.handleRemove(tx)
    }
  }

  async getTargets (accounts: Ref<Account>[] | undefined): Promise<string[] | undefined> {
    if (accounts === undefined) return
    const users = await this.storage.modelDb.findAll(core.class.Account, { _id: { $in: accounts } })
    return users.map((p) => p.email)
  }

  async tx (ctx: SessionContext, tx: Tx): Promise<TxMiddlewareResult> {
    const h = this.storage.hierarchy
    let targets: string[] | undefined

    if (h.isDerived(tx._class, core.class.TxCUD)) {
      const cudTx = tx as TxCUD<Doc>
      const isSpace = h.isDerived(cudTx.objectClass, core.class.Space)
      if (isSpace) {
        await this.handleTx(ctx, cudTx as TxCUD<Space>)
      }
      const space = this.privateSpaces[tx.objectSpace]
      if (space !== undefined) {
        const account = await getUser(this.storage, ctx)
        if (account !== core.account.System) {
          const allowed = this.allowedSpaces[account]
          if (allowed === undefined || !allowed.includes(isSpace ? (cudTx.objectId as Ref<Space>) : tx.objectSpace)) {
            throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
          }
        }
        targets = await this.getTargets(this.privateSpaces[tx.objectSpace]?.members)
      }
    }

    const res = await this.provideTx(ctx, tx)
    return [res[0], res[1], mergeTargets(targets, res[2])]
  }

  private async getAllAllowedSpaces (ctx: SessionContext): Promise<Ref<Space>[]> {
    let userSpaces: Ref<Space>[] = []
    try {
      const account = await getUser(this.storage, ctx)
      userSpaces = this.allowedSpaces[account] ?? []
      return [...userSpaces, account as string as Ref<Space>, ...this.publicSpaces, ...this.systemSpaces]
    } catch {
      return [...this.publicSpaces, ...this.systemSpaces]
    }
  }

  private async mergeQuery<T extends Doc>(
    ctx: SessionContext,
    query: ObjQueryType<T['space']>
  ): Promise<ObjQueryType<T['space']>> {
    const spaces = await this.getAllAllowedSpaces(ctx)
    if (typeof query === 'string') {
      if (!spaces.includes(query)) {
        throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
      }
    } else if (query.$in !== undefined) {
      query.$in = query.$in.filter((p) => spaces.includes(p))
    } else {
      query.$in = spaces
    }
    return query
  }

  override async findAll<T extends Doc>(
    ctx: SessionContext,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    const newQuery = query
    if (query.space !== undefined) {
      newQuery.space = await this.mergeQuery(ctx, query.space)
    } else {
      const spaces = await this.getAllAllowedSpaces(ctx)
      newQuery.space = { $in: spaces }
    }
    const findResult = await this.provideFindAll(ctx, _class, newQuery, options)
    if (options?.lookup !== undefined) {
      for (const object of findResult) {
        if (object.$lookup !== undefined) {
          await this.filterLookup(ctx, object.$lookup)
        }
      }
    }
    return findResult
  }

  async isUnavailable (ctx: SessionContext, space: Ref<Space>): Promise<boolean> {
    if (this.privateSpaces[space] === undefined) return false
    const account = await getUser(this.storage, ctx)
    if (account === core.account.System) return false
    return !this.allowedSpaces[account]?.includes(space)
  }

  async filterLookup<T extends Doc>(ctx: SessionContext, lookup: LookupData<T>): Promise<void> {
    for (const key in lookup) {
      const val = lookup[key]
      if (Array.isArray(val)) {
        const arr: AttachedDoc[] = []
        for (const value of val) {
          if (!(await this.isUnavailable(ctx, value.space))) {
            arr.push(value)
          }
        }
        lookup[key] = arr as any
      } else if (val !== undefined) {
        if (await this.isUnavailable(ctx, val.space)) {
          lookup[key] = undefined
        }
      }
    }
  }
}