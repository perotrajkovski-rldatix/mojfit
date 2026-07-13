import Capacitor
import StoreKit

@objc(StoreKitBillingPlugin)
public class StoreKitBillingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StoreKitBillingPlugin"
    public let jsName = "StoreKitBilling"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchaseSubscription", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getActiveSubscriptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise),
    ]

    private var cachedProducts: [String: Product] = [:]
    private var updatesTask: Task<Void, Never>?

    override public func load() {
        // Listens for transactions that arrive outside an explicit purchaseSubscription call
        // (renewals, Ask to Buy approvals, family sharing, or a purchase that completed after
        // the app was killed mid-flow) — mirrors PlayBillingPlugin's notifyRestoredPurchase.
        updatesTask = Task { [weak self] in
            for await update in Transaction.updates {
                guard let self else { continue }
                if case .verified(let transaction) = update {
                    await transaction.finish()
                    self.notifyListeners("purchaseRestored", data: [
                        "productId": transaction.productID,
                        "purchaseToken": String(transaction.id),
                    ])
                }
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    // The Capacitor build shipped for this toolchain has a packaging bug: CAPPluginCall.reject(...)
    // and every optional-returning getString/getArray overload are wrapped in a
    // `#if compiler(>=5.3) && $NonescapableTypes` block that evaluates false here, so those
    // symbols don't exist at all under this compiler. Route "rejection" through resolve() with
    // an error marker instead — storeKitBilling.ts unwraps this back into a real thrown error,
    // so callers in App.tsx see the exact same try/catch behavior as before.
    private func rejectViaResolve(_ call: CAPPluginCall, _ message: String) {
        call.resolve(["__error": message])
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        let rawIds = call.getArray("productIds", [])
        let productIds = rawIds.compactMap { $0 as? String }
        guard !productIds.isEmpty else {
            rejectViaResolve(call, "productIds are required")
            return
        }

        Task {
            do {
                let products = try await Product.products(for: productIds)
                var out: [[String: Any]] = []

                for product in products {
                    cachedProducts[product.id] = product

                    var item: [String: Any] = [
                        "productId": product.id,
                        "title": product.displayName,
                        "description": product.description,
                        "price": product.displayPrice,
                    ]
                    if let period = product.subscription?.subscriptionPeriod {
                        item["billingPeriod"] = Self.isoBillingPeriod(period)
                    }
                    out.append(item)
                }

                call.resolve(["products": out])
            } catch {
                rejectViaResolve(call, "Product query failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func purchaseSubscription(_ call: CAPPluginCall) {
        let productId = call.getString("productId", "")
        guard !productId.isEmpty else {
            rejectViaResolve(call, "productId is required")
            return
        }

        guard let product = cachedProducts[productId] else {
            rejectViaResolve(call, "Missing product details for \(productId). Call getProducts first.")
            return
        }

        Task {
            do {
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        await transaction.finish()
                        call.resolve(["success": true])
                    case .unverified(_, let error):
                        rejectViaResolve(call, "Purchase verification failed: \(error.localizedDescription)")
                    }
                case .userCancelled:
                    rejectViaResolve(call, "Purchase cancelled")
                case .pending:
                    rejectViaResolve(call, "Purchase is pending approval (Ask to Buy). It will complete once approved.")
                @unknown default:
                    rejectViaResolve(call, "Unknown purchase result")
                }
            } catch {
                rejectViaResolve(call, "Purchase failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func getActiveSubscriptions(_ call: CAPPluginCall) {
        Task {
            let purchases = await currentActiveSubscriptions()
            call.resolve(["purchases": purchases])
        }
    }

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task {
            do {
                // Forces reconciliation with Apple's servers (vs. the possibly-stale local
                // transaction cache) — this is the "Restore Purchases" entry point App Review
                // requires apps with subscriptions to expose.
                try await AppStore.sync()
            } catch {
                rejectViaResolve(call, "Restore failed: \(error.localizedDescription)")
                return
            }
            let purchases = await currentActiveSubscriptions()
            call.resolve(["purchases": purchases])
        }
    }

    private func currentActiveSubscriptions() async -> [[String: Any]] {
        var purchases: [[String: Any]] = []

        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  transaction.productType == .autoRenewable,
                  transaction.revocationDate == nil else { continue }

            var autoRenewing = false
            if let statuses = try? await cachedProducts[transaction.productID]?.subscription?.status {
                if let matching = statuses.first(where: { status in
                    if case .verified(let info) = status.transaction {
                        return info.id == transaction.id || info.productID == transaction.productID
                    }
                    return false
                }), case .verified(let renewalInfo) = matching.renewalInfo {
                    autoRenewing = renewalInfo.willAutoRenew
                }
            }

            purchases.append([
                "productId": transaction.productID,
                "purchaseToken": String(transaction.id),
                "acknowledged": true,
                "autoRenewing": autoRenewing,
                "purchaseTime": transaction.purchaseDate.timeIntervalSince1970 * 1000,
            ])
        }

        return purchases
    }

    private static func isoBillingPeriod(_ period: Product.SubscriptionPeriod) -> String {
        let unit: String
        switch period.unit {
        case .day: unit = "D"
        case .week: unit = "W"
        case .month: unit = "M"
        case .year: unit = "Y"
        @unknown default: unit = "M"
        }
        return "P\(period.value)\(unit)"
    }
}
