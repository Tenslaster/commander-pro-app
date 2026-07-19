Commander PRO — host on your domain (crew.kingdom.forum)
========================================================

WHAT THIS FOLDER IS
-------------------
- index.html          → install instructions page
- CommanderPro.ipa    → the app package (unsigned; SideStore signs on phone)

WHY NOT "Safari install button" ONLY?
-------------------------------------
Apple blocks free Apple IDs from installing random IPAs via Safari OTA
(the itms-services method needs paid Ad Hoc / Enterprise signing).

With a FREE Apple ID, the supported DIY path is:
  SideStore on iPhone → login with Apple ID → SideStore signs & installs the IPA.

Your domain is still useful: one link to download the IPA + clear steps.


UPLOAD TO YOUR DOMAIN
---------------------
Put the whole `ios-install` folder on your web server, for example:

  https://crew.kingdom.forum/ios/
    index.html
    CommanderPro.ipa

Nginx example:

  location /ios/ {
    alias /var/www/crew/ios/;
    add_header Content-Disposition 'attachment' always;  # optional for .ipa
  }

  # Make sure .ipa is served as application/octet-stream
  types {
    application/octet-stream ipa;
  }

Cloudflare: HTTPS is already fine. Avoid "email obfuscation" on the page.
If download is blocked, set a Cache Rule or Page Rule to bypass for /ios/*


ON THE IPHONE
-------------
1. Safari → https://crew.kingdom.forum/ios/
2. Install SideStore (sidestore.io) if needed
3. Download CommanderPro.ipa
4. SideStore → install that IPA with your free Apple ID
5. Refresh every ~7 days in SideStore


REFRESH IPA AFTER NEW BUILD
---------------------------
Copy the new .ipa over CommanderPro.ipa in this folder and re-upload.
