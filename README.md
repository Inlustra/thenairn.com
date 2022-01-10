#TheNairns server

![Disk space](https://netdata.thenairn.com/api/v1/badge.svg?chart=disk_space._&alarm=disk_space_usage&refresh=auto)

![Load](https://netdata.thenairn.com/api/v1/badge.svg?chart=system.load&alarm=load_average_5&refresh=auto)

![CPU](https://netdata.thenairn.com/api/v1/badge.svg?chart=system.cpu&alarm=10min_cpu_usage&refresh=auto)

# Restore config from backup

- Create 3 different unraid shares:
  - /mnt/user/Paperless
  - /mnt/user/Config
  - /mnt/user/Nextcloud
- Install the RClone Unraid plugin
- Set RClone config
  - Replace CLIENT_ID
  - Replace CLIENT_SECRET
  - Replace ACCESS_TOKEN
  - Replace ROOT_FOLDER_ID
  - Replace PASSWORD
  - Replace PASSWORD2

```
[gcloud]
type = drive
client_id = CLIENT_ID
client_secret = CLIENT_SECRET
scope = drive.file
root_folder_id = ROOT_FOLDER_ID
token = ACCESS_TOKEN

[gclouddocs]
type = crypt
remote = gcloud:/docs
filename_encryption = obfuscate
directory_name_encryption = false
password = PASSWORD
password2 = PASSWORD2

[gcloudconfig]
type = crypt
remote = gcloud:/config
filename_encryption = obfuscate
directory_name_encryption = false
password = PASSWORD
password2 = PASSWORD_2

[gcloudnextcloud]
type = crypt
remote = gcloud:/config
filename_encryption = obfuscate
directory_name_encryption = false
password = PASSWORD
password2 = PASSWORD2
```


- Start restore:


Run restore:
```bash
#!/bin/bash
echo "starting paperless restore"
rclone copy -v gclouddocs: /mnt/user/Paperless/ 
echo "starting config restore"
rclone copy -v gcloudconfig: /mnt/user/Config/
echo "starting nextcloud restore"
rclone copy -v gcloudnextcloud: /mnt/user/Nextcloud/
```

- Start docker-compose