import Testing
@testable import CodeBurnMenubar

@Suite("Period nesting cache guard")
struct PeriodNestingCacheTests {
    @Test("containment lists only true supersets")
    func containment() {
        #expect(Period.lifetime.containingPeriods.isEmpty)
        #expect(Period.all.containingPeriods == [.lifetime])
        #expect(Period.thirtyDays.containingPeriods == [.all, .lifetime])
        #expect(Period.month.containingPeriods == [.all, .lifetime])
        // 7 and 30 day windows can reach into the previous calendar month, so
        // they are deliberately not nested with it in either direction.
        #expect(!Period.sevenDays.containingPeriods.contains(.month))
        #expect(!Period.thirtyDays.containingPeriods.contains(.month))
        #expect(!Period.month.containingPeriods.contains(.thirtyDays))
        #expect(Period.today.containingPeriods.contains(.month))
    }

    @Test("containment is antisymmetric, so two periods never invalidate each other")
    func antisymmetric() {
        for a in Period.allCases {
            for b in a.containingPeriods {
                #expect(!b.containingPeriods.contains(a), "\(a) and \(b) contain each other")
            }
        }
    }

    @Test("a longer cached period below a fresh shorter one is stale")
    func longerBelowShorterIsStale() {
        // Lifetime cached at ¥216,000 while 6M just fetched ¥216,900: the
        // lifetime entry predates the newer sessions. This is the exact shape
        // that made Lifetime render less than 6M after a tab switch.
        #expect(AppStore.nestedCacheIsStale(
            cachedCost: 216_000, cachedCalls: 74_000,
            fetchedCost: 216_900, fetchedCalls: 74_900,
            cachedIsShorter: false))
    }

    @Test("a shorter cached period above a fresh longer one is stale")
    func shorterAboveLongerIsStale() {
        #expect(AppStore.nestedCacheIsStale(
            cachedCost: 300, cachedCalls: 10,
            fetchedCost: 200, fetchedCalls: 10,
            cachedIsShorter: true))
        #expect(AppStore.nestedCacheIsStale(
            cachedCost: 200, cachedCalls: 11,
            fetchedCost: 200, fetchedCalls: 10,
            cachedIsShorter: true))
    }

    @Test("consistent caches are kept")
    func consistentCachesSurvive() {
        // Longer period above the shorter one: normal.
        #expect(!AppStore.nestedCacheIsStale(
            cachedCost: 500, cachedCalls: 50,
            fetchedCost: 200, fetchedCalls: 20,
            cachedIsShorter: false))
        // Identical totals, which is what Lifetime and 6M look like until the
        // history is older than six months.
        #expect(!AppStore.nestedCacheIsStale(
            cachedCost: 216_900, cachedCalls: 74_900,
            fetchedCost: 216_900, fetchedCalls: 74_900,
            cachedIsShorter: false))
        #expect(!AppStore.nestedCacheIsStale(
            cachedCost: 216_900, cachedCalls: 74_900,
            fetchedCost: 216_900, fetchedCalls: 74_900,
            cachedIsShorter: true))
    }

    @Test("a sub-cent difference is not treated as a contradiction")
    func repricingNoiseIsTolerated() {
        // Repricing can move a total by fractions of a cent; that must not
        // evict a cache and trigger an expensive refetch on every poll.
        #expect(!AppStore.nestedCacheIsStale(
            cachedCost: 216_900.001, cachedCalls: 74_900,
            fetchedCost: 216_900.004, fetchedCalls: 74_900,
            cachedIsShorter: false))
    }
}
