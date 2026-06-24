# Bug: Empty folders are not deleted when deleting files

**Issue:** Empty folders are not deleted when deleting files from those folders during sync operations.

**Expected behavior:** When files are deleted from a folder as part of the sync process, if that folder becomes empty, it should be automatically deleted.

**Actual behavior:** Empty folders remain in the vault after files within them have been deleted.
