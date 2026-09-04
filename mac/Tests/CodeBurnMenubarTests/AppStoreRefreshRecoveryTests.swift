import Foundation
import Testing
@testable import CodeBurnMenubar

private func combinedUsage(cost: Double = 12.5) -> CombinedUsage {
    CombinedUsage(
        perDevice: [
            CombinedDeviceUsage(
                id: "local",
                name: "MacBook",
                local: true,
                error: nil,
                cost: cost,
                calls: 3,
                sessions: 2,
                inputTokens: 100,
                outputTokens: 50,
                cacheCreateTokens: 10,
                cacheReadTokens: 20,
                totalTokens: 180
            )
        ],
        combined: CombinedUsageTotals(
            cost: cost,
            calls: 3,
            sessions: 2,
            inputTokens: 100,
            outputTokens: 50,
            cacheCreateTokens: 10,
            cacheReadTokens: 20,
            totalTokens: 180,
            deviceCount: 1,
            reachableCount: 1
        )
    )
}

private func claudeConfigSelector(selectedId: String? = nil) -> ClaudeConfigSelector {
    ClaudeConfigSelector(
        selectedId: selectedId,
        options: [
            ClaudeConfigOption(id: "claude-config:work", label: "claude-work", path: "/tmp/claude-work"),
            ClaudeConfigOption(id: "claude-config:personal", label: "claude-personal", path: "/tmp/claude-personal")
        ]
    )
}

private func menubarPayload(cost: Double,
                            calls: Int = 1,
                            sessions: Int = 1,
                            inputTokens: Int = 1,
                            outputTokens: Int = 1,
                            providers: [String: Double]? = nil,
                            providerDetails: [ProviderDetail] = [],
                            combined: CombinedUsage? = nil,
                            claudeConfigs: ClaudeConfigSelector? = nil) -> MenubarPayload {
    MenubarPayload(
        generated: "test",
        current: CurrentBlock(
            label: "Today",
            cost: cost,
            calls: calls,
            sessions: sessions,
            oneShotRate: nil,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            cacheHitPercent: 0,
            codexCredits: nil,
            topActivities: [],
            topModels: [],
            localModelSavings: LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: []),
            providers: providers ?? ["claude": cost],
            providerDetails: providerDetails,
            topProjects: [],
            modelEfficiency: [],
            topSessions: [],
            retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
            routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: []),
            tools: [],
            skills: [],
            subagents: [],
            mcpServers: []
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: []),
        combined: combined,
        claudeConfigs: claudeConfigs
    )
}

@Suite("AppStore refresh recovery")
@MainActor
struct AppStoreRefreshRecoveryTests {
    @Test("an active all-provider slice rejects a contradictory scoped zero")
    func activeAllProviderSliceRejectsScopedZero() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 11.5, "hermes agent": 0.5],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 11.5, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0.5, calls: 7, hasUsage: true),
            ]
        )
        let falseZero = menubarPayload(
            cost: 0,
            calls: 0,
            sessions: 0,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: false),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())
        store.suppressRefreshesForTesting()
        store.switchTo(provider: .hermes)
        store.setCachedPayloadForTesting(falseZero, period: .today, provider: .hermes, fetchedAt: Date())

        #expect(store.providerPayloadContradictsAllForTesting(falseZero, period: .today, provider: .hermes))
        // The Hermes tab must show NO dollar figure. It used to fall back to the
        // previous selection's payload and print $12, which is Claude's spend
        // plus Hermes', under a tab labelled Hermes.
        #expect(!store.hasCachedData)
        #expect(store.payload.current.cost == 0)
        #expect(store.payload.current.calls == 0)
        #expect(store.needsInteractivePayloadRefresh)
    }

    @Test("positive provider spend cannot disappear when scoped calls survive")
    func positiveSpendCannotDisappearWhenScopedCallsSurvive() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 11.5, "hermes agent": 0.5],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 11.5, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0.5, calls: 7, hasUsage: true),
            ]
        )
        let missingSpend = menubarPayload(
            cost: 0,
            calls: 7,
            sessions: 7,
            inputTokens: 100,
            outputTokens: 20,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 7, hasUsage: true),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(store.providerPayloadContradictsAllForTesting(missingSpend, period: .today, provider: .hermes))
    }

    /// The reported bug: the provider tab advertised ¥3032 while the hero under it
    /// read ¥433 -- both figures on screen at once. The scoped payload was a
    /// snapshot from hours earlier, and the zero-only contract waved it through
    /// because it was not zero, merely 14% of the truth.
    @Test("a scoped payload holding a fraction of the tab's spend is stale")
    func scopedPayloadFarBelowTheAllSliceIsStale() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 505,
            providers: ["hermes agent": 496],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 496, calls: 1589, hasUsage: true),
            ]
        )
        let hoursOld = menubarPayload(
            cost: 64.57,
            calls: 115,
            sessions: 6,
            providers: ["hermes agent": 64.57],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 64.57, calls: 115, hasUsage: true),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())
        store.suppressRefreshesForTesting()
        store.switchTo(provider: .hermes)
        store.setCachedPayloadForTesting(hoursOld, period: .today, provider: .hermes, fetchedAt: Date())

        #expect(store.providerPayloadContradictsAllForTesting(hoursOld, period: .today, provider: .hermes))
        // Nothing is printed under the tab until the real figure lands.
        #expect(!store.hasCachedData)
        #expect(store.needsInteractivePayloadRefresh)
    }

    /// The counterweight: these are two CLI runs seconds apart against a corpus
    /// that is still being written to, so the scoped slice legitimately trails
    /// the all-provider one. Measured drift on a live machine was 1499 vs 1589
    /// calls -- rejecting that would blank the popover on every refresh.
    @Test("ordinary drift between the two slices is not stale")
    func ordinaryDriftBetweenSlicesIsAccepted() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 509.50,
            providers: ["hermes agent": 509.50],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 509.50, calls: 1589, hasUsage: true),
            ]
        )
        let slightlyBehind = menubarPayload(
            cost: 494.59,
            calls: 1499,
            sessions: 16,
            providers: ["hermes agent": 494.59],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 494.59, calls: 1499, hasUsage: true),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(!store.providerPayloadContradictsAllForTesting(slightlyBehind, period: .today, provider: .hermes))
    }

    @Test("flat-rate activity rejects a contradictory scoped zero")
    func flatRateActivityRejectsScopedZero() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 12, "hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 12, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 7, hasUsage: true),
            ]
        )
        let falseZero = menubarPayload(
            cost: 0,
            calls: 0,
            sessions: 0,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: false),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(store.providerPayloadContradictsAllForTesting(falseZero, period: .today, provider: .hermes))
    }

    @Test("token-only activity accepts a scoped payload with matching usage")
    func tokenOnlyActivityAcceptsMatchingScopedUsage() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 12, "hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 12, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: true),
            ]
        )
        let tokenOnly = menubarPayload(
            cost: 0,
            calls: 0,
            sessions: 1,
            inputTokens: 100,
            outputTokens: 20,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: true),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(!store.providerPayloadContradictsAllForTesting(tokenOnly, period: .today, provider: .hermes))
    }

    @Test("scoped providerDetails hasUsage remains authoritative with empty headline totals")
    func scopedProviderDetailsUsageRemainsAuthoritative() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 12, "hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 12, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: true),
            ]
        )
        let providerDetailOnly = menubarPayload(
            cost: 0,
            calls: 0,
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: true),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(!store.providerPayloadContradictsAllForTesting(providerDetailOnly, period: .today, provider: .hermes))
    }

    @Test("token-only activity rejects a completely empty scoped payload")
    func tokenOnlyActivityRejectsEmptyScopedPayload() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 12, "hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 12, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: true),
            ]
        )
        let empty = menubarPayload(
            cost: 0,
            calls: 0,
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: false),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(store.providerPayloadContradictsAllForTesting(empty, period: .today, provider: .hermes))
    }

    @Test("late all-provider evidence invalidates an already cached scoped zero")
    func lateAllProviderEvidenceInvalidatesScopedZero() {
        let store = AppStore()
        let falseZero = menubarPayload(
            cost: 0,
            calls: 0,
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: false),
            ]
        )
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 11.5, "hermes agent": 0.5],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 11.5, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0.5, calls: 7, hasUsage: true),
            ]
        )

        store.suppressRefreshesForTesting()
        store.switchTo(provider: .hermes)
        store.setCachedPayloadForTesting(falseZero, period: .today, provider: .hermes, fetchedAt: Date())
        #expect(store.hasCachedData)

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(!store.hasCachedData)
        #expect(store.needsInteractivePayloadRefresh)
    }

    @Test("quiet refresh joins matching in-flight evidence instead of racing ahead")
    func quietRefreshJoinsMatchingInFlightEvidence() async {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 11.5, "hermes agent": 0.5],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 11.5, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0.5, calls: 7, hasUsage: true),
            ]
        )
        store.setCacheDateToTodayForTesting()
        store.seedInFlightForTesting(period: .today, provider: .all, insertedAt: Date())

        let joined = Task { @MainActor in
            await store.refreshQuietlyForTesting(period: .today, provider: .all)
        }
        while store.inFlightWaiterCountForTesting(period: .today, provider: .all) == 0 {
            await Task.yield()
        }

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())
        store.finishInFlightForTesting(period: .today, provider: .all)

        #expect(await joined.value)
    }

    @Test("refresh pipeline reset releases matching in-flight waiters")
    func refreshPipelineResetReleasesInFlightWaiters() async {
        let store = AppStore()
        store.setCacheDateToTodayForTesting()
        store.seedInFlightForTesting(period: .today, provider: .all, insertedAt: Date())

        let joined = Task { @MainActor in
            await store.refreshQuietlyForTesting(period: .today, provider: .all)
        }
        while store.inFlightWaiterCountForTesting(period: .today, provider: .all) == 0 {
            await Task.yield()
        }

        store.resetLoadingState()

        #expect(!(await joined.value))
        #expect(!store.isInFlightForTesting(period: .today, provider: .all))
    }

    @Test("selection refresh snapshots scoped and all-provider keys together")
    func selectionRefreshSnapshotsMatchingKeys() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        store.switchTo(period: .month)
        store.switchTo(provider: .hermes)

        let snapshot = store.selectionRefreshKeysForTesting()
        store.switchTo(period: .today)
        store.switchTo(provider: .cursor)

        #expect(snapshot.scoped.period == .month)
        #expect(snapshot.scoped.provider == .hermes)
        #expect(snapshot.all.period == .month)
        #expect(snapshot.all.provider == .all)
        #expect(snapshot.scoped.day == snapshot.all.day)
        #expect(snapshot.scoped.days == snapshot.all.days)
        #expect(snapshot.scoped.claudeConfigSourceId == snapshot.all.claudeConfigSourceId)
    }

    @Test("a genuine provider zero remains valid when the all-provider slice is also zero")
    func genuineProviderZeroRemainsValid() {
        let store = AppStore()
        let all = menubarPayload(
            cost: 12,
            providers: ["claude": 12, "hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 12, calls: 4, hasUsage: true),
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: false),
            ]
        )
        let zero = menubarPayload(
            cost: 0,
            calls: 0,
            sessions: 0,
            providers: ["hermes agent": 0],
            providerDetails: [
                ProviderDetail(id: "hermes", label: "Hermes Agent", cost: 0, calls: 0, hasUsage: false),
            ]
        )

        store.setCachedPayloadForTesting(all, period: .today, provider: .all, fetchedAt: Date())

        #expect(!store.providerPayloadContradictsAllForTesting(zero, period: .today, provider: .hermes))
    }

    @Test("a provider switch shows no figure until the target provider loads")
    func providerSwitchShowsNoStaleFigure() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 12.34),
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        store.switchTo(provider: .cursor)

        // Keeping the all-provider payload mounted under the Cursor tab is not
        // continuity, it is a wrong number: $12.34 is every provider's spend.
        // Empty here is what puts the popover on its loading state instead.
        #expect(store.selectedProvider == .cursor)
        #expect(!store.hasCachedData)
        #expect(store.payload.current.cost == 0)

        // The all-provider selection still reads its own cached payload.
        store.switchTo(provider: .all)
        #expect(store.hasCachedData)
        #expect(store.payload.current.cost == 12.34)
    }

    @Test("stale visible payload triggers hard recovery without clearing cache")
    func stalePayloadTriggersHardRecoveryWithoutClearingCache() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 92.33),
            period: .today,
            provider: .all,
            fetchedAt: Date().addingTimeInterval(-180)
        )

        #expect(store.todayPayload?.current.cost == 92.33)
        #expect(store.needsInteractivePayloadRefresh)
        #expect(store.needsStatusPayloadRefresh)
        #expect(store.hasStaleInteractivePayload)
        #expect(store.shouldResetInteractiveRefreshPipeline)

        store.resetRefreshState(clearCache: false)

        #expect(store.todayPayload?.current.cost == 92.33)
    }

    @Test("fresh visible payload does not trigger hard recovery")
    func freshPayloadDoesNotTriggerHardRecovery() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 164.06),
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(!store.needsInteractivePayloadRefresh)
        #expect(!store.needsStatusPayloadRefresh)
        #expect(!store.hasStaleInteractivePayload)
        #expect(!store.shouldResetInteractiveRefreshPipeline)
    }

    @Test("payload cache partitions local and combined scope")
    func payloadCachePartitionsByScope() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 10),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 99, combined: combinedUsage(cost: 42)),
            scope: .combined,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(store.cachedPayloadForTesting(scope: .local, period: .today, provider: .all)?.current.cost == 10)
        #expect(store.cachedPayloadForTesting(scope: .combined, period: .today, provider: .all)?.current.cost == 99)

        store.selectedScope = .combined

        #expect(store.payload.current.cost == 10)
        #expect(store.payload.combined?.combined.cost == 42)
    }

    @Test("multi-day combined selection uses local cache path")
    func multiDayCombinedSelectionUsesLocalCachePath() {
        let store = AppStore()
        let days: Set<String> = ["2026-06-01", "2026-06-02"]
        store.selectedScope = .combined
        store.selectedDays = days

        store.setCachedPayloadForTesting(
            menubarPayload(cost: 18),
            scope: .local,
            period: .today,
            provider: .all,
            days: days,
            fetchedAt: Date()
        )
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 99, combined: combinedUsage(cost: 44)),
            scope: .combined,
            period: .today,
            provider: .all,
            days: days,
            fetchedAt: Date()
        )

        #expect(store.activeScope == .local)
        #expect(store.payload.current.cost == 18)
        #expect(store.payload.combined == nil)
    }

    @Test("combined failure state does not invalidate local badge payload")
    func combinedFailureDoesNotInvalidateLocalBadgePayload() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 31),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )
        store.selectedScope = .combined
        store.setLastErrorForTesting(
            "timeout",
            scope: .combined,
            period: .today,
            provider: .all
        )

        #expect(store.lastError == "timeout")
        #expect(store.menubarPayload?.current.cost == 31)
        #expect(!store.needsStatusPayloadRefresh)
        #expect(store.payload.current.cost == 31)
        #expect(store.payload.combined == nil)
    }

    @Test("menubar badge shows the combined total under combined scope")
    func menubarBadgeShowsCombinedTotal() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        let period = store.menubarPeriod
        // Local badge figure and a higher cross-device combined total, both for
        // the badge's period.
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 30),
            scope: .local,
            period: period,
            provider: .all,
            fetchedAt: Date()
        )
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 30, combined: combinedUsage(cost: 75)),
            scope: .combined,
            period: period,
            provider: .all,
            fetchedAt: Date()
        )

        // Local scope: no combined total, so the badge renders the local figure.
        store.selectedScope = .local
        #expect(store.menubarBadgeCombined == nil)

        // Combined scope: the badge total is the cross-device aggregate ($75),
        // not the local $30 — this is the fix for the badge trailing the popover.
        store.selectedScope = .combined
        #expect(store.menubarBadgeCombined?.cost == 75)
    }

    @Test("badge reports a device shortfall when a paired peer is unreachable")
    func menubarBadgeReportsDeviceShortfall() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        let period = store.menubarPeriod
        // Combined payload where only 1 of 2 paired devices reported this cycle
        // (the peer is asleep/off-network), so the aggregate is degraded to local.
        let degraded = CombinedUsage(
            perDevice: [],
            combined: CombinedUsageTotals(
                cost: 30,
                calls: 3,
                sessions: 2,
                inputTokens: 100,
                outputTokens: 50,
                cacheCreateTokens: 10,
                cacheReadTokens: 20,
                totalTokens: 180,
                deviceCount: 2,
                reachableCount: 1
            )
        )
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 30, combined: degraded),
            scope: .combined,
            period: period,
            provider: .all,
            fetchedAt: Date()
        )
        store.selectedScope = .combined

        let shortfall = store.menubarBadgeDeviceShortfall
        #expect(shortfall?.reachable == 1)
        #expect(shortfall?.total == 2)
    }

    @Test("badge reports no shortfall when every paired device reports")
    func menubarBadgeNoShortfallWhenAllReachable() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        let period = store.menubarPeriod
        // combinedUsage() carries deviceCount == reachableCount == 1.
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 30, combined: combinedUsage(cost: 30)),
            scope: .combined,
            period: period,
            provider: .all,
            fetchedAt: Date()
        )
        store.selectedScope = .combined
        #expect(store.menubarBadgeDeviceShortfall == nil)

        // Local scope never reports a shortfall.
        store.selectedScope = .local
        #expect(store.menubarBadgeDeviceShortfall == nil)
    }

    @Test("menubar badge falls back to local when no combined payload is cached")
    func menubarBadgeFallsBackWhenCombinedMissing() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        let period = store.menubarPeriod
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 30),
            scope: .local,
            period: period,
            provider: .all,
            fetchedAt: Date()
        )
        // Combined scope selected but no combined payload cached yet (cold cache
        // or an unreachable peer): the badge must fall back to the local figure.
        store.selectedScope = .combined
        #expect(store.menubarBadgeCombined == nil)
    }

    @Test("switching to combined resets selected provider to all")
    func switchingToCombinedResetsSelectedProviderToAll() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        store.selectedScope = .local
        store.selectedProvider = .claude

        store.switchTo(scope: .combined)

        #expect(store.selectedScope == .combined)
        #expect(store.selectedProvider == .all)
    }

    @Test("selected Claude config partitions payload cache")
    func selectedClaudeConfigPartitionsPayloadCache() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 10, claudeConfigs: claudeConfigSelector()),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 4, claudeConfigs: claudeConfigSelector(selectedId: "claude-config:work")),
            scope: .local,
            period: .today,
            provider: .all,
            claudeConfigSourceId: "claude-config:work",
            fetchedAt: Date()
        )

        #expect(store.payload.current.cost == 10)

        store.selectedClaudeConfigSourceId = "claude-config:work"

        #expect(store.payload.current.cost == 4)
        #expect(store.cachedPayloadForTesting(scope: .local, period: .today, provider: .all)?.current.cost == 10)
        #expect(store.cachedPayloadForTesting(scope: .local, period: .today, provider: .all, claudeConfigSourceId: "claude-config:work")?.current.cost == 4)
    }

    @Test("Claude config selector is hidden until multiple configs are available")
    func claudeConfigSelectorVisibilityRequiresMultipleConfigs() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 1),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )
        #expect(!store.shouldShowClaudeConfigSelector)

        store.setCachedPayloadForTesting(
            menubarPayload(cost: 2, claudeConfigs: claudeConfigSelector()),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(store.shouldShowClaudeConfigSelector)
        #expect(store.claudeConfigOptions.map(\.label) == ["claude-work", "claude-personal"])
    }

    @Test("selecting Claude config resets provider and combined scope")
    func selectingClaudeConfigResetsProviderAndCombinedScope() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        store.selectedScope = .combined
        store.selectedProvider = .codex

        store.switchTo(claudeConfigSourceId: "claude-config:work")

        #expect(store.selectedClaudeConfigSourceId == "claude-config:work")
        #expect(store.selectedScope == .local)
        #expect(store.selectedProvider == .all)
    }

    @Test("daily budget warning is suppressed for combined scope")
    func dailyBudgetWarningIsSuppressedForCombinedScope() {
        let defaults = UserDefaults.standard
        let previousDisplayMetric = defaults.object(forKey: "CodeBurnDisplayMetric")
        let previousDailyBudget = defaults.object(forKey: "CodeBurnDailyBudget")
        defer {
            if let previousDisplayMetric {
                defaults.set(previousDisplayMetric, forKey: "CodeBurnDisplayMetric")
            } else {
                defaults.removeObject(forKey: "CodeBurnDisplayMetric")
            }
            if let previousDailyBudget {
                defaults.set(previousDailyBudget, forKey: "CodeBurnDailyBudget")
            } else {
                defaults.removeObject(forKey: "CodeBurnDailyBudget")
            }
        }

        let store = AppStore()
        store.selectedScope = .local
        store.selectedDays = []
        store.displayMetric = .cost
        store.dailyBudget = 10
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 12.5),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(store.isOverDailyBudget)
        #expect(store.shouldShowDailyBudgetWarning)

        store.selectedScope = .combined

        #expect(store.isOverDailyBudget)
        #expect(!store.shouldShowDailyBudgetWarning)
    }

    @Test("missing today status payload needs status refresh")
    func missingTodayStatusPayloadNeedsStatusRefresh() {
        let store = AppStore()

        #expect(store.todayPayload == nil)
        #expect(store.needsStatusPayloadRefresh)
    }

    @Test("missing unattempted payload triggers hard recovery")
    func missingUnattemptedPayloadTriggersHardRecovery() {
        let store = AppStore()

        #expect(!store.hasCachedData)
        #expect(!store.hasAttemptedCurrentKeyLoad)
        #expect(store.needsInteractivePayloadRefresh)
        #expect(store.hasMissingInteractivePayloadWithoutAttempt)
        #expect(store.shouldResetInteractiveRefreshPipeline)
    }

    @Test("orphaned stale in-flight entry does not block stuck-loading recovery")
    func staleInFlightDoesNotBlockRecovery() {
        let store = AppStore()
        // A quiet refresh torn down across sleep/wake can leave an in-flight
        // entry behind for the current key with no cache and no active loading
        // counter, far older than the watchdog window. Recovery must clear it
        // and proceed instead of bailing on the in-flight guard forever.
        store.seedInFlightForTesting(period: .today, provider: .all, insertedAt: Date().addingTimeInterval(-3600))

        #expect(store.isInFlightForTesting(period: .today, provider: .all))

        let canRecover = store.prepareStuckLoadingRecovery()

        #expect(canRecover)
        #expect(!store.isInFlightForTesting(period: .today, provider: .all))
    }

    @Test("healthy in-flight fetch is not killed by recovery")
    func healthyInFlightFetchSurvivesRecovery() {
        let store = AppStore()
        store.seedInFlightForTesting(period: .today, provider: .all, insertedAt: Date())

        let canRecover = store.prepareStuckLoadingRecovery()

        #expect(!canRecover)
        #expect(store.isInFlightForTesting(period: .today, provider: .all))
    }

    @Test("prepareStuckLoadingRecovery clears stale loading bookkeeping for the current key")
    func popoverRecoveryClearsStuckLoading() {
        let store = AppStore()
        // Seed an orphaned in-flight entry older than the 60s watchdog so the
        // stale-clear path runs, mimicking a fetch torn down across sleep/wake.
        store.seedInFlightForTesting(
            period: .today,
            provider: .all,
            insertedAt: Date().addingTimeInterval(-120)
        )
        #expect(store.isInFlightForTesting(period: .today, provider: .all))

        let willFetch = store.prepareStuckLoadingRecovery()

        #expect(willFetch)
        #expect(!store.isInFlightForTesting(period: .today, provider: .all))
    }

}
