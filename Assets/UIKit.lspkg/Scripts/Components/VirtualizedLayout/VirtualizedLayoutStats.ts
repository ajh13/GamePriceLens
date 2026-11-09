export type VirtualizedLayoutSizeMode = "static" | "uniformCallback" | "variable"

export interface VirtualizedLayoutDebugStats {
  readonly createCount: number
  readonly bindCount: number
  readonly unbindCount: number
  readonly recycleCount: number
  readonly growCount: number
  readonly shrinkCount: number
  readonly createCountByType: ReadonlyMap<string, number>
  readonly recycleCountByType: ReadonlyMap<string, number>
  readonly growCountByType: ReadonlyMap<string, number>
  readonly shrinkCountByType: ReadonlyMap<string, number>
  readonly poolSize: number
  readonly poolSizesByType: ReadonlyMap<string, number>
  readonly totalItems: number
  readonly sizeMode: VirtualizedLayoutSizeMode
  readonly typedPooling: boolean
}

export interface VirtualizedLayoutMetadataAdapter<TType extends string = string> {
  getItemSize?(dataIndex: number): number | undefined
  getItemType?(dataIndex: number): TType
  isItemSizeUniform?: boolean
}

export interface VirtualizedLayoutMetadataLogger {
  w(message: string): void
}

/** Keeps a recycler ring inside the live data range near either boundary. */
export function clampVirtualizedWindowStart(requestedStartIndex: number, totalItems: number, ringSize: number): number {
  const maximumStartIndex = Math.max(0, totalItems - ringSize)
  return Math.max(0, Math.min(Math.floor(requestedStartIndex), maximumStartIndex))
}

export class VirtualizedLayoutMetadata<TType extends string = string> {
  public readonly sizes: number[] = []
  public readonly cumulativeSizes: number[] = []
  public readonly dataTypes: string[] = []
  public readonly needsMeasure: boolean[] = []

  private readonly _defaultType: string
  private readonly _logger: VirtualizedLayoutMetadataLogger | null
  private _configuredItemSize: number = 0
  private _gap: number = 0
  private _uniformItemSize: number = 0
  private _totalItems: number = 0
  private _sizeMode: VirtualizedLayoutSizeMode = "static"
  private _typedPooling: boolean = false
  private _resolvedPrefixEnd: number = -1
  private _liveDataTypesCache: Set<string> | null = null
  private _typeCounts: Map<string, number> | null = null

  public constructor(defaultType: string, logger?: VirtualizedLayoutMetadataLogger) {
    this._defaultType = defaultType
    this._logger = logger ?? null
  }

  public get sizeMode(): VirtualizedLayoutSizeMode {
    return this._sizeMode
  }

  public get typedPooling(): boolean {
    return this._typedPooling
  }

  public get activeItemSize(): number {
    return this._sizeMode === "uniformCallback" ? this._uniformItemSize : this._configuredItemSize
  }

  public get activeStride(): number {
    return this.activeItemSize + this._gap
  }

  public get resolvedPrefixEnd(): number {
    return this._resolvedPrefixEnd
  }

  public get liveDataTypes(): ReadonlySet<string> | null {
    return this._liveDataTypesCache
  }

  public static resolveSizeMode(adapter: VirtualizedLayoutMetadataAdapter | null): VirtualizedLayoutSizeMode {
    if (adapter?.getItemSize === undefined) return "static"
    return adapter.isItemSizeUniform === true ? "uniformCallback" : "variable"
  }

  public static resolveTypedPooling(adapter: VirtualizedLayoutMetadataAdapter | null): boolean {
    return adapter?.getItemType !== undefined
  }

  public reset(): void {
    this._configuredItemSize = 0
    this._gap = 0
    this._uniformItemSize = 0
    this._totalItems = 0
    this._sizeMode = "static"
    this._typedPooling = false
    this._resolvedPrefixEnd = -1
    this._liveDataTypesCache = null
    this._typeCounts = null
    this.sizes.length = 0
    this.cumulativeSizes.length = 0
    this.dataTypes.length = 0
    this.needsMeasure.length = 0
  }

  public rebuild(
    adapter: VirtualizedLayoutMetadataAdapter<TType> | null,
    totalItems: number,
    configuredItemSize: number,
    gap: number
  ): void {
    this._totalItems = totalItems
    this._configuredItemSize = configuredItemSize
    this._gap = gap
    this._sizeMode = VirtualizedLayoutMetadata.resolveSizeMode(adapter)
    this._typedPooling = VirtualizedLayoutMetadata.resolveTypedPooling(adapter)
    this._uniformItemSize = this.resolveUniformItemSize(adapter, totalItems, configuredItemSize)
    this.rebuildArrays(adapter)
  }

  public matchesAdapterShape(adapter: VirtualizedLayoutMetadataAdapter<TType> | null): boolean {
    return (
      this._sizeMode === VirtualizedLayoutMetadata.resolveSizeMode(adapter) &&
      this._typedPooling === VirtualizedLayoutMetadata.resolveTypedPooling(adapter)
    )
  }

  public invalidateSizes(
    start: number,
    end: number,
    adapter: VirtualizedLayoutMetadataAdapter<TType> | null,
    configuredItemSize: number,
    gap: number
  ): void {
    this._configuredItemSize = configuredItemSize
    this._gap = gap
    if (this._sizeMode === "uniformCallback") {
      this._uniformItemSize = this.resolveUniformItemSize(adapter, this._totalItems, configuredItemSize)
      if (this._typedPooling) this.invalidateTypes(start, end, adapter)
      return
    }
    this._uniformItemSize = configuredItemSize
    if (this._sizeMode === "static") {
      if (this._typedPooling) this.invalidateTypes(start, end, adapter)
      return
    }

    const safeStart = Math.max(0, start)
    const safeEnd = Math.min(this._totalItems, end)
    for (let i = safeStart; i < safeEnd; i++) {
      const raw = this.resolveItemSizeRaw(adapter, i)
      this.sizes[i] = this.coerceSize(raw)
      this.needsMeasure[i] = raw === undefined
      if (this._typedPooling) this.setTypeAtIndex(i, this.resolveItemType(adapter, i))
    }
    this.rebuildCumulativesFrom(safeStart)
  }

  public updateGap(gap: number): void {
    if (this._gap === gap) return
    this._gap = gap
    // Cumulative sums were built with the old gap; mark them invalid so
    // topOfItem falls back to stride extrapolation until the next rebuild.
    this._resolvedPrefixEnd = -1
  }

  public invalidateTypes(start: number, end: number, adapter: VirtualizedLayoutMetadataAdapter<TType> | null): void {
    if (!this._typedPooling) return
    const safeStart = Math.max(0, start)
    const safeEnd = Math.min(this._totalItems, end)
    for (let i = safeStart; i < safeEnd; i++) {
      this.setTypeAtIndex(i, this.resolveItemType(adapter, i))
    }
  }

  public typeAtIndex(dataIndex: number): string {
    return this.dataTypes[dataIndex] ?? this._defaultType
  }

  public sizeAtIndex(dataIndex: number): number {
    if (this._sizeMode !== "variable") return this.activeItemSize
    const size = this.sizes[dataIndex]
    return size > 0 ? size : this._configuredItemSize
  }

  public hasResolvedSize(dataIndex: number): boolean {
    return this._sizeMode !== "variable" || dataIndex <= this._resolvedPrefixEnd
  }

  public needsMeasureAt(dataIndex: number): boolean {
    return this._sizeMode === "variable" && this.needsMeasure[dataIndex] === true
  }

  public setMeasuredSize(dataIndex: number, measured: number): boolean {
    if (this._sizeMode !== "variable") return false
    if (dataIndex < 0 || dataIndex >= this.needsMeasure.length) return false
    if (!this.needsMeasure[dataIndex]) return false
    this.needsMeasure[dataIndex] = false
    if (measured === this.sizes[dataIndex]) return false
    this.sizes[dataIndex] = measured
    return true
  }

  public rebuildCumulativesFrom(fromIndex: number): void {
    const n = this._totalItems
    if (this._sizeMode !== "variable") return
    if (fromIndex < 0) fromIndex = 0
    if (fromIndex >= n) return
    if (fromIndex > 0 && fromIndex - 1 > this._resolvedPrefixEnd) return
    if (this._resolvedPrefixEnd >= fromIndex) {
      this._resolvedPrefixEnd = fromIndex - 1
    }
    let cum = fromIndex === 0 ? 0 : this.cumulativeSizes[fromIndex - 1]
    for (let i = fromIndex; i < n; i++) {
      if (this.sizes[i] < 0) break
      if (i > 0) cum += this._gap
      cum += this.sizes[i]
      this.cumulativeSizes[i] = cum
      this._resolvedPrefixEnd = i
    }
  }

  public topOfItem(dataIndex: number): number {
    if (dataIndex <= 0) return 0
    if (this._sizeMode !== "variable") return dataIndex * this.activeStride
    if (dataIndex - 1 <= this._resolvedPrefixEnd) {
      return this.cumulativeSizes[dataIndex - 1] + this._gap
    }
    const stride = this._configuredItemSize + this._gap
    if (this._resolvedPrefixEnd < 0) return dataIndex * stride
    const baseCum = this.cumulativeSizes[this._resolvedPrefixEnd]
    const unresolvedCount = dataIndex - 1 - this._resolvedPrefixEnd
    return baseCum + this._gap + unresolvedCount * stride
  }

  public computeTotalContentSize(totalSlots: number): number {
    if (totalSlots <= 0) return 0
    if (this._sizeMode !== "variable") {
      return totalSlots * this.activeItemSize + Math.max(0, totalSlots - 1) * this._gap
    }
    if (this._resolvedPrefixEnd >= totalSlots - 1) {
      return this.cumulativeSizes[totalSlots - 1]
    }
    const stride = this._configuredItemSize + this._gap
    if (this._resolvedPrefixEnd < 0) {
      return totalSlots * this._configuredItemSize + Math.max(0, totalSlots - 1) * this._gap
    }
    const base = this.cumulativeSizes[this._resolvedPrefixEnd]
    const unresolvedCount = totalSlots - 1 - this._resolvedPrefixEnd
    return base + unresolvedCount * stride
  }

  private rebuildArrays(adapter: VirtualizedLayoutMetadataAdapter<TType> | null): void {
    const n = this._totalItems
    const needsVariableSizes = this._sizeMode === "variable"
    const needsTypes = this._typedPooling

    this.sizes.length = needsVariableSizes ? n : 0
    this.cumulativeSizes.length = needsVariableSizes ? n : 0
    this.needsMeasure.length = needsVariableSizes ? n : 0
    this.dataTypes.length = needsTypes ? n : 0
    this._resolvedPrefixEnd = -1
    this._typeCounts = needsTypes ? new Map<string, number>() : null
    this._liveDataTypesCache = needsTypes ? new Set<string>() : null

    if (n === 0 || (!needsVariableSizes && !needsTypes)) return

    let cum = 0
    let prefixIntact = true
    const typeCounts = this._typeCounts
    const liveTypes = this._liveDataTypesCache
    for (let i = 0; i < n; i++) {
      if (needsTypes && typeCounts !== null && liveTypes !== null) {
        const t = this.resolveItemType(adapter, i)
        this.dataTypes[i] = t
        const c = (typeCounts.get(t) ?? 0) + 1
        typeCounts.set(t, c)
        if (c === 1) liveTypes.add(t)
      }

      if (!needsVariableSizes) continue
      const raw = this.resolveItemSizeRaw(adapter, i)
      if (raw === undefined) {
        this.sizes[i] = -1
        this.needsMeasure[i] = true
        prefixIntact = false
      } else {
        const size = typeof raw === "number" ? raw : this._configuredItemSize
        this.sizes[i] = size
        this.needsMeasure[i] = false
        if (prefixIntact) {
          if (i > 0) cum += this._gap
          cum += size
          this.cumulativeSizes[i] = cum
          this._resolvedPrefixEnd = i
        }
      }
    }
  }

  private setTypeAtIndex(i: number, newType: string): void {
    const oldType = this.dataTypes[i]
    this.dataTypes[i] = newType
    if (oldType === newType) return
    const counts = this._typeCounts
    const live = this._liveDataTypesCache
    if (counts === null || live === null) return
    if (oldType !== undefined) {
      const oldCount = (counts.get(oldType) ?? 0) - 1
      if (oldCount <= 0) {
        counts.delete(oldType)
        live.delete(oldType)
      } else {
        counts.set(oldType, oldCount)
      }
    }
    const nextCount = (counts.get(newType) ?? 0) + 1
    counts.set(newType, nextCount)
    if (nextCount === 1) live.add(newType)
  }

  private resolveUniformItemSize(
    adapter: VirtualizedLayoutMetadataAdapter<TType> | null,
    totalItems: number,
    configuredItemSize: number
  ): number {
    if (this._sizeMode !== "uniformCallback" || totalItems <= 0 || adapter?.getItemSize === undefined) {
      return configuredItemSize
    }
    const sampled = adapter.getItemSize(0)
    if (typeof sampled === "number" && Number.isFinite(sampled) && sampled > 0) return sampled
    this._logger?.w(
      `VirtualizedLayout: uniform getItemSize(0) returned ${sampled}; using configured itemSize ${configuredItemSize}`
    )
    return configuredItemSize
  }

  private resolveItemSizeRaw(
    adapter: VirtualizedLayoutMetadataAdapter<TType> | null,
    dataIndex: number
  ): number | undefined | null {
    if (adapter?.getItemSize === undefined) return null
    const r = adapter.getItemSize(dataIndex)
    if (r === undefined) return undefined
    if (typeof r === "number" && r > 0) return r
    return null
  }

  private coerceSize(raw: number | undefined | null): number {
    if (raw === undefined) return -1
    return typeof raw === "number" ? raw : this._configuredItemSize
  }

  private resolveItemType(adapter: VirtualizedLayoutMetadataAdapter<TType> | null, dataIndex: number): string {
    if (adapter?.getItemType !== undefined) {
      const t = adapter.getItemType(dataIndex)
      if (typeof t === "string" && t.length > 0) return t
    }
    return this._defaultType
  }
}

export class VirtualizedLayoutStats {
  private readonly _defaultType: string
  private _createCount: number = 0
  private _bindCount: number = 0
  private _unbindCount: number = 0
  private _recycleCount: number = 0
  private _growCount: number = 0
  private _shrinkCount: number = 0
  private readonly _createCountByType: Map<string, number> = new Map()
  private readonly _recycleCountByType: Map<string, number> = new Map()
  private readonly _growCountByType: Map<string, number> = new Map()
  private readonly _shrinkCountByType: Map<string, number> = new Map()
  private _typeBreakdownEnabled: boolean = false

  public constructor(defaultType: string) {
    this._defaultType = defaultType
  }

  public get typeBreakdownEnabled(): boolean {
    return this._typeBreakdownEnabled
  }

  public set typeBreakdownEnabled(value: boolean) {
    this._typeBreakdownEnabled = value
  }

  public recordCreate(type: string | undefined): void {
    this._createCount++
    this.incrementTypeCount(this._createCountByType, type)
  }

  public recordBind(): void {
    this._bindCount++
  }

  public recordUnbind(): void {
    this._unbindCount++
  }

  public recordRecycle(type: string | undefined): void {
    this._recycleCount++
    this.incrementTypeCount(this._recycleCountByType, type)
  }

  public recordGrow(type: string | undefined): void {
    this._growCount++
    this.incrementTypeCount(this._growCountByType, type)
  }

  public recordShrink(type: string | undefined): void {
    this._shrinkCount++
    this.incrementTypeCount(this._shrinkCountByType, type)
  }

  public snapshot(
    poolSize: number,
    poolSizesByType: ReadonlyMap<string, number>,
    totalItems: number,
    sizeMode: VirtualizedLayoutSizeMode,
    typedPooling: boolean
  ): VirtualizedLayoutDebugStats {
    return {
      createCount: this._createCount,
      bindCount: this._bindCount,
      unbindCount: this._unbindCount,
      recycleCount: this._recycleCount,
      growCount: this._growCount,
      shrinkCount: this._shrinkCount,
      createCountByType: new Map<string, number>(this._createCountByType),
      recycleCountByType: new Map<string, number>(this._recycleCountByType),
      growCountByType: new Map<string, number>(this._growCountByType),
      shrinkCountByType: new Map<string, number>(this._shrinkCountByType),
      poolSize,
      poolSizesByType: new Map<string, number>(poolSizesByType),
      totalItems,
      sizeMode,
      typedPooling
    }
  }

  private incrementTypeCount(counts: Map<string, number>, type: string | undefined): void {
    // Per-type maps are opt-in: skip the Map churn on the recycle hot path
    // unless a consumer has asked for the breakdown. Scalar counters stay on.
    if (!this._typeBreakdownEnabled) return
    const key = this.normalizeType(type)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  private normalizeType(type: string | undefined): string {
    return type !== undefined && type.length > 0 ? type : this._defaultType
  }
}
