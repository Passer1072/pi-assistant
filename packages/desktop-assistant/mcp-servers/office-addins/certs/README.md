# Runtime Certificates

The plugin installer writes generated localhost certificate files here under the
user data asset directory, not in this repository folder.

Generated `*.pfx` and `*.cer` files are ignored by git and may be removed when
the last Office live add-in using the certificate is uninstalled.
