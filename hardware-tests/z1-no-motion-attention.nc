; Sensei hardware validation: no axis, spindle, laser, or coolant commands.
G21
G90
G4 P2
(@z1-attention {"type":"rotary_index","axis":"A","target":0,"operation":"Sensei no-motion validation","instruction":"No physical action required; verify the notification, then resume."})
M600
G4 P2
M2
