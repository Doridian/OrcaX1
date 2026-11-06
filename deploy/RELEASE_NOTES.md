## Install / upgrade

Needs a Bambu Lab X1 / X1C / X1E running [X1Plus](https://github.com/X1Plus/X1Plus) with SSH enabled.

1. Download `orcax1-<version>.zip` below and unpack it to the **root of the printer's SD card**, so you get an `orcax1` folder at the top level. Either:
   - put the SD card in a PC and unpack it there, or
   - upload the unpacked `orcax1` folder with an FTP client (FileZilla etc.): FTPS with implicit TLS, port 990, user `bblp`, password = the LAN access code (printer screen → Settings → Network).
2. SSH into the printer as root and run:
   ```sh
   sh /mnt/sdcard/orcax1/install.sh
   ```
3. Open the `https://<printer-ip>/` address it prints and accept the certificate warning.

To upgrade from a version that has it, upload this zip under **Settings → Update** in the web UI (it installs and restarts by itself), or unpack it over the old one and run `install.sh` again. To remove: `sh /mnt/sdcard/orcax1/install.sh uninstall`.
