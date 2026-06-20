package com.fridactl

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    companion object {
        const val VPN_REQUEST_CODE = 0x0F00
        var vpnPermissionCallback: ((Boolean) -> Unit)? = null
    }

    override fun getMainComponentName(): String = "FridaCtl"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    /** Called by TrafficModule to request VPN permission via system dialog */
    fun requestVpnPermission(callback: (Boolean) -> Unit) {
        val intent = VpnService.prepare(this)
        if (intent == null) {
            // Already granted
            callback(true)
        } else {
            vpnPermissionCallback = callback
            startActivityForResult(intent, VPN_REQUEST_CODE)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == VPN_REQUEST_CODE) {
            val granted = resultCode == Activity.RESULT_OK
            vpnPermissionCallback?.invoke(granted)
            vpnPermissionCallback = null
        } else {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }
}
