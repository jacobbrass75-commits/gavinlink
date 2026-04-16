from django.db import models


class SaleRecord(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        OPEN = "open", "Open"
        FULFILLED = "fulfilled", "Fulfilled"
        CANCELED = "canceled", "Canceled"

    channel = models.ForeignKey(
        "channels.ChannelAccount",
        on_delete=models.PROTECT,
        related_name="sale_records",
    )
    external_order_id = models.CharField(max_length=120)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DRAFT)
    currency = models.CharField(max_length=3, default="USD")
    subtotal_cents = models.PositiveIntegerField(default=0)
    fees_cents = models.PositiveIntegerField(default=0)
    net_cents = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["channel", "external_order_id"],
                name="unique_sale_record_per_channel",
            )
        ]

    def __str__(self) -> str:
        return f"{self.external_order_id} ({self.get_status_display()})"

