import Capacitor
import UIKit

// Registers custom native plugins that aren't distributed as npm/SPM packages
// (e.g. StoreKitBillingPlugin) with the Capacitor bridge. capacitorDidLoad() is
// the earliest timing-safe hook — it runs once the bridge exists, before the
// web view starts loading JS, so registerPluginInstance() is guaranteed to run
// before any JS code could try to call the plugin.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        // CAPBridgeViewController.bridge's getter is wrapped in a broken
        // `#if compiler(>=5.3) && $NonescapableTypes` conditional in this Capacitor
        // release's shipped interface, making it invisible to this toolchain even though
        // it exists at runtime. Reach it via KVC instead, then cast to CAPBridgeProtocol,
        // whose registerPluginInstance requirement isn't affected by that same bug.
        if let bridge = self.value(forKey: "bridge") as? CAPBridgeProtocol {
            bridge.registerPluginInstance(StoreKitBillingPlugin())
        }
    }
}
