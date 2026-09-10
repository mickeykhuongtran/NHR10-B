import React from 'react';
import { Bluetooth, BluetoothConnected, BluetoothOff, Thermometer } from 'lucide-react';
import { BatteryIndicator } from './ui/BatteryIndicator';
import { ConnectionStatus, Settings } from '../types';

interface HeaderProps {
  status: ConnectionStatus;
  settings: Settings;
  onConnect: () => void;
  onDisconnect: () => void;
}

export const Header: React.FC<HeaderProps> = ({ status, settings, onConnect, onDisconnect }) => {
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800 text-white shadow-md">
      <div className="flex items-center gap-3">
        {status === 'connected' ? (
          <BluetoothConnected className="text-blue-500 animate-pulse" size={24} />
        ) : status === 'connecting' ? (
          <Bluetooth className="text-yellow-500 animate-spin" size={24} />
        ) : (
          <BluetoothOff className="text-slate-500" size={24} />
        )}
        <div>
          <h1 className="text-lg font-bold tracking-tight">NHR-10 RFID</h1>
          <p className="text-xs text-slate-400 font-mono">
            {status === 'connected' ? `Connected to ${settings.deviceInfo}` : 'Disconnected'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {status === 'connected' && (
          <>
            <div className="flex items-center gap-1 text-sm font-mono bg-slate-800 px-2 py-1 rounded">
              <Thermometer size={16} className="text-orange-400" />
              <span>{settings.temperature}°C</span>
            </div>
            <div className="flex items-center gap-1 text-sm font-mono bg-slate-800 px-2 py-1 rounded">
              <BatteryIndicator snapshot={settings.batterySnapshot} connected={status === 'connected'} />
            </div>
          </>
        )}
        
        <button
          onClick={status === 'connected' ? onDisconnect : onConnect}
          className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
            status === 'connected'
              ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/50'
              : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'
          }`}
        >
          {status === 'connected' ? 'DISCONNECT' : status === 'connecting' ? 'CONNECTING...' : 'CONNECT'}
        </button>
      </div>
    </header>
  );
};
