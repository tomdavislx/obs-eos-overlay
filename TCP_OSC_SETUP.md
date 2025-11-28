# TCP OSC Setup Guide for ETC Eos Console

This document explains how to configure your ETC Eos console for TCP OSC connection on port 3037 (Third Party OSC).

## Prerequisites

1. **Eos Software Version**: Third Party OSC support requires Eos v3.1.0 or higher
2. **Network Access**: Your server must be on the same network as the console

## Console Configuration Steps

### 1. Enable Third Party OSC

1. Exit to the **Eos Shell** (close the current show file)
2. Navigate to **Settings** > **Network** > **Interface Protocols**
3. Enable **Third Party OSC** for your network interface
4. This opens port 3037 for TCP OSC connections

### 2. Enable "Allow Remotes"

1. In the main Eos interface, go to **Setup** > **Remotes**
2. Enable **Allow Remotes**
3. **Important**: Port 3037 is governed by this setting - if "Allow Remotes" is disabled, port 3037 is also disabled

### 3. Configure TCP OSC Mode (if needed)

1. Navigate to **Setup** > **System** > **Show Control** > **OSC**
2. Ensure **OSC TCP Mode** is set to:
   - **OSC 1.1 (SLIP)** - Recommended for Third Party OSC
   - OR **OSC 1.0 (Packet Length)** - Alternative option

### 4. Verify Network Settings

- Ensure both **OSC RX** and **OSC TX** are enabled in **Setup** > **System** > **Show Control** > **OSC**
- Your server IP should be reachable from the console

## Testing the Connection

Before running the server, you can test if port 3037 is open:

```bash
# From your server machine
nc -zv 10.101.100.101 3037
```

**Expected result**: `Connection succeeded` or similar success message

**If connection is refused**:
- Verify Third Party OSC is enabled in Eos Shell
- Verify "Allow Remotes" is enabled
- Try restarting the console
- Check console logs/diagnostics for any errors

## Server Configuration

Set these environment variables or use the launch configuration:

```bash
OSC_PROTOCOL=TCP
EOS_HOST=10.101.100.101
OSC_PORT=3037
USE_EOS_CONSOLE_API=false  # Disable to avoid port conflict
```

Or use the VS Code launch configuration: **"Run Server (TCP OSC)"**

## Troubleshooting

### Connection Refused

- **Symptom**: `ECONNREFUSED` error
- **Solutions**:
  1. Verify Third Party OSC is enabled in Eos Shell
  2. Verify "Allow Remotes" is enabled (Setup > Remotes)
  3. Check if port 3037 appears in console's network diagnostics
  4. Try restarting the console after enabling Third Party OSC

### Connection Timeout

- **Symptom**: Connection hangs and times out
- **Solutions**:
  1. Verify network connectivity: `ping 10.101.100.101`
  2. Check firewall rules on both server and console
  3. Verify server IP is correct
  4. Check console network configuration

### No OSC Messages Received

- **Symptom**: Connection succeeds but no messages arrive
- **Solutions**:
  1. Verify OSC subscription is sent: `/eos/subscribe=1`
  2. Check console is sending OSC messages (use Diagnostics tab)
  3. Verify OSC TX is enabled on console
  4. Check OSC message filters on console

## Alternative: UDP OSC

If TCP OSC continues to have issues, UDP OSC is the standard and more reliable method:

```bash
OSC_PROTOCOL=UDP
OSC_PORT=8001  # Console should send OSC to this port
```

The console should be configured to:
- **OSC TX Port**: 8001 (send to your server)
- **OSC RX Port**: 8000 (receive from your server, if needed)

## References

- [Eos OSC Setup Documentation](https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/23_Show_Control/08_OSC/Using_OSC_with_Eos/Eos_OSC_Setup.htm)
- [OSC Third Party Integration](https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/23_Show_Control/08_OSC/Using_OSC_with_Eos/OSC_Third-Party_Integration/OSC_Third-Party_Integration.htm)

