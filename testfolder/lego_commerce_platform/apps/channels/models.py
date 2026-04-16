from django.db import models


class ChannelAccount(models.Model):
    class Provider(models.TextChoices):
        BRICKLINK = "bricklink", "BrickLink"
        EBAY = "ebay", "eBay"
        WHATNOT = "whatnot", "Whatnot"
        AIRTABLE = "airtable", "Airtable"
        CUSTOM = "custom", "Custom"

    name = models.CharField(max_length=120)
    provider = models.CharField(max_length=32, choices=Provider.choices)
    external_account_id = models.CharField(max_length=120, blank=True, default="")
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.name} ({self.get_provider_display()})"

