---
description: Tool options for the CAM mode
---

# Tools

The Tool menu can be accessed from the top-right corner dropdown.

![](/img/CAM/toolsTab.png)

Once selected, the Tool menu provides options to create, copy, edit, and delete tools.  
Additionally, tools can be imported and exported as `.km` files. The file format is binary-encoded and not human-readable, so don't try to edit it with a text editor.

![](/img/CAM/toolMenu.png)

Kiri:Moto supports these types of tools:

- End Mills
- Ball Mills
- Bull Nose Mills
- Taper Mills
- Taper Ball Mills
- Drills

## Bull nose cutters

Select **bull nose** in the tool editor. Use the flute diameter for cutter diameter D and flute length for cutter height H. The shaft fields specify the narrower shank separately.

**Corner radius R1** rounds the edge of the cutter. **Bottom radius R2** defines the shallow spherical bottom and joins smoothly to R1. Set R2 to zero for a flat bottom. Dimensions use the tool's metric or inch setting.

For the reference cutter, enable metric and enter:

| Field | Value (mm) |
| --- | --- |
| Flute diameter D | 32.16 |
| Flute length H | 71.83 |
| Corner radius R1 | 9.93 |
| Bottom radius R2 | 191.69 |

Enter the shaft diameter and length from your cutter specifications. Save the tool and select it in your CAM operation. The editor preview, contour profile, and stock simulations use the bull nose geometry; the indexed simulation approximates the curved bottom with 64 radial segments.

The editor limits R1 to half the cutter diameter. A positive R2 must be at least half the diameter, and cutter height must accommodate the rounded bottom; smaller entries are raised to these limits.
