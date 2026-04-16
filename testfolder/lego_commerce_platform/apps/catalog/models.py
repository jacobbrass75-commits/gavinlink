import uuid

from django.db import models


class CatalogItem(models.Model):
    class Kind(models.TextChoices):
        SET = "set", "Set"
        PART = "part", "Part"
        MINIFIG = "minifig", "Minifig"
        ACCESSORY = "accessory", "Accessory"
        MIXED_LOT = "mixed_lot", "Mixed Lot"
        OTHER = "other", "Other"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    internal_sku = models.CharField(max_length=64, unique=True)
    kind = models.CharField(max_length=24, choices=Kind.choices)
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    bricklink_item_type = models.CharField(max_length=32, blank=True)
    bricklink_item_number = models.CharField(max_length=64, blank=True)
    bricklink_color_id = models.CharField(max_length=32, blank=True)
    condition = models.CharField(max_length=32, blank=True)
    completeness = models.CharField(max_length=32, blank=True)
    sealed = models.BooleanField(default=False)
    active = models.BooleanField(default=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["internal_sku"]
        indexes = [
            models.Index(fields=["kind", "active"]),
            models.Index(fields=["bricklink_item_type", "bricklink_item_number"]),
        ]

    def __str__(self) -> str:
        return f"{self.internal_sku} - {self.title}"

